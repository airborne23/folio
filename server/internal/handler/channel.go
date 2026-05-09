package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/airborne23/folio/server/internal/events"
	db "github.com/airborne23/folio/server/pkg/db/generated"
)

// Mentions support Unicode letters/numbers so CJK agent names like
// "系统架构师" tokenize correctly. The token starts with a letter or digit
// (\p{L} | \p{N}) and continues with letter/number/underscore/hyphen — the
// same Slack-ish vocabulary, just Unicode-aware. Whitespace and most
// punctuation terminate the token, so "@系统架构师，你好" still extracts
// "系统架构师" cleanly.
var mentionTokenRe = regexp.MustCompile(`@([\p{L}\p{N}][\p{L}\p{N}_\-]*)`)

func extractMentionTokens(body string) []string {
	matches := mentionTokenRe.FindAllStringSubmatch(body, -1)
	seen := map[string]bool{}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		t := strings.ToLower(m[1])
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// ChannelResponse is the wire shape for a channel — stringified UUIDs and timestamps.
type ChannelResponse struct {
	ID                       string  `json:"id"`
	WorkspaceID              string  `json:"workspace_id"`
	Name                     *string `json:"name"`
	Kind                     string  `json:"kind"`
	Topic                    *string `json:"topic"`
	CreatorMemberID          *string `json:"creator_member_id"`
	ArchivedAt               *string `json:"archived_at"`
	DefaultSubscribeMode     string  `json:"default_subscribe_mode"`
	AgentCooldownMs          int32   `json:"agent_cooldown_ms"`
	MaxConsecutiveAgentTurns int32   `json:"max_consecutive_agent_turns"`
	ConsecutiveAgentTurns    int32   `json:"consecutive_agent_turns"`
	CreatedAt                string  `json:"created_at"`
	UpdatedAt                string  `json:"updated_at"`
}

func channelToResponse(c db.Channel) ChannelResponse {
	return ChannelResponse{
		ID:                       uuidToString(c.ID),
		WorkspaceID:              uuidToString(c.WorkspaceID),
		Name:                     textToPtr(c.Name),
		Kind:                     c.Kind,
		Topic:                    textToPtr(c.Topic),
		CreatorMemberID:          uuidToPtr(c.CreatorMemberID),
		ArchivedAt:               timestampToPtr(c.ArchivedAt),
		DefaultSubscribeMode:     c.DefaultSubscribeMode,
		AgentCooldownMs:          c.AgentCooldownMs,
		MaxConsecutiveAgentTurns: c.MaxConsecutiveAgentTurns,
		ConsecutiveAgentTurns:    c.ConsecutiveAgentTurns,
		CreatedAt:                timestampToString(c.CreatedAt),
		UpdatedAt:                timestampToString(c.UpdatedAt),
	}
}

type CreateChannelRequest struct {
	Name                     *string `json:"name"`
	Kind                     string  `json:"kind"`
	Topic                    *string `json:"topic"`
	DefaultSubscribeMode     *string `json:"default_subscribe_mode"`
	AgentCooldownMs          *int32  `json:"agent_cooldown_ms"`
	MaxConsecutiveAgentTurns *int32  `json:"max_consecutive_agent_turns"`
}

func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace context required")
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	var req CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate kind / name interaction up front. Mirrors the DB CHECK constraint
	// channel_name_required_unless_group_dm but with friendlier error messages.
	switch req.Kind {
	case "public", "private":
		if req.Name == nil {
			writeError(w, http.StatusBadRequest, "name is required for public/private channels")
			return
		}
		// Trim and reject empty/whitespace-only — the DB CHECK uses length(trim(name)) > 0.
		if strings.TrimSpace(*req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty or whitespace-only")
			return
		}
	case "group_dm":
		// Any provided name (including the empty string) is rejected — group_dm rows
		// store SQL NULL, and ptrToText(&"") would produce a non-NULL empty string
		// that violates channel_name_required_unless_group_dm.
		if req.Name != nil {
			writeError(w, http.StatusBadRequest, "name must be omitted for group_dm channels")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "kind must be one of: public, private, group_dm")
		return
	}

	// Pull the calling member from middleware-cached context (production) or fall
	// back to a DB lookup (tests). Mirrors agent.go / comment.go usage.
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	defaultMode := "subscribe"
	if req.DefaultSubscribeMode != nil {
		defaultMode = *req.DefaultSubscribeMode
	}
	cooldown := int32(30000)
	if req.AgentCooldownMs != nil {
		cooldown = *req.AgentCooldownMs
	}
	maxTurns := int32(5)
	if req.MaxConsecutiveAgentTurns != nil {
		maxTurns = *req.MaxConsecutiveAgentTurns
	}

	// CreateChannel + auto-add creator to channel_member must be atomic — without
	// the second row, private/group_dm channels would be invisible to their own
	// creator. Mirrors the workspace.go::CreateWorkspace + CreateMember pattern.
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create channel")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	channel, err := qtx.CreateChannel(r.Context(), db.CreateChannelParams{
		WorkspaceID:              workspaceUUID,
		Name:                     ptrToText(req.Name),
		Kind:                     req.Kind,
		Topic:                    ptrToText(req.Topic),
		CreatorMemberID:          pgtype.UUID{Bytes: member.ID.Bytes, Valid: true},
		DefaultSubscribeMode:     defaultMode,
		AgentCooldownMs:          cooldown,
		MaxConsecutiveAgentTurns: maxTurns,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a channel with that name already exists in this workspace")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	// Auto-add the creator to channel_member. subscribe_mode left NULL so the
	// creator inherits channel.default_subscribe_mode.
	creatorMember, err := qtx.UpsertChannelMember(r.Context(), db.UpsertChannelMemberParams{
		ChannelID:  channel.ID,
		MemberType: "member",
		MemberID:   member.ID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to register channel creator as member")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	// Publish after commit so a rollback does not leak phantom events.
	h.Bus.Publish(events.ChannelCreated(workspaceID, channel))
	h.Bus.Publish(events.ChannelMemberAdded(workspaceID, creatorMember))

	writeJSON(w, http.StatusCreated, channelToResponse(channel))
}

func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListChannelsForMember(r.Context(), db.ListChannelsForMemberParams{
		WorkspaceID: workspaceUUID,
		MemberID:    member.ID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list channels")
		return
	}
	resp := make([]ChannelResponse, len(rows))
	for i, c := range rows {
		resp[i] = channelToResponse(c)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetChannel(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	c, err := h.Queries.GetChannelByID(r.Context(), db.GetChannelByIDParams{
		ID:          channelUUID,
		WorkspaceID: workspaceUUID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch channel")
		return
	}
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}
	writeJSON(w, http.StatusOK, channelToResponse(c))
}

type PatchChannelRequest struct {
	Name                     *string `json:"name"`
	Topic                    *string `json:"topic"`
	DefaultSubscribeMode     *string `json:"default_subscribe_mode"`
	AgentCooldownMs          *int32  `json:"agent_cooldown_ms"`
	MaxConsecutiveAgentTurns *int32  `json:"max_consecutive_agent_turns"`
}

func (h *Handler) PatchChannel(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	var req PatchChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Block name updates on group_dm channels: the DB CHECK forbids non-NULL
	// name on group_dm and would surface SQLSTATE 23514 as a 500.
	if req.Name != nil {
		current, err := h.Queries.GetChannelByID(r.Context(), db.GetChannelByIDParams{
			ID:          channelUUID,
			WorkspaceID: workspaceUUID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "lookup failed")
			return
		}
		if current.Kind == "group_dm" {
			writeError(w, http.StatusBadRequest, "group_dm channels cannot be renamed")
			return
		}
		if strings.TrimSpace(*req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty or whitespace-only")
			return
		}
	}
	if req.DefaultSubscribeMode != nil {
		switch *req.DefaultSubscribeMode {
		case "mention_only", "subscribe":
		default:
			writeError(w, http.StatusBadRequest, "default_subscribe_mode must be mention_only or subscribe")
			return
		}
	}

	params := db.UpdateChannelParams{
		ID:          channelUUID,
		WorkspaceID: workspaceUUID,
		Name:        ptrToText(req.Name),
		Topic:       ptrToText(req.Topic),
	}
	if req.DefaultSubscribeMode != nil {
		params.DefaultSubscribeMode = pgtype.Text{String: *req.DefaultSubscribeMode, Valid: true}
	}
	if req.AgentCooldownMs != nil {
		params.AgentCooldownMs = pgtype.Int4{Int32: *req.AgentCooldownMs, Valid: true}
	}
	if req.MaxConsecutiveAgentTurns != nil {
		params.MaxConsecutiveAgentTurns = pgtype.Int4{Int32: *req.MaxConsecutiveAgentTurns, Valid: true}
	}
	updated, err := h.Queries.UpdateChannel(r.Context(), params)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a channel with that name already exists in this workspace")
			return
		}
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	h.Bus.Publish(events.ChannelUpdated(workspaceID, updated))
	writeJSON(w, http.StatusOK, channelToResponse(updated))
}

func (h *Handler) ArchiveChannel(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	archived, err := h.Queries.ArchiveChannel(r.Context(), db.ArchiveChannelParams{
		ID:          channelUUID,
		WorkspaceID: workspaceUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "channel not found or already archived")
			return
		}
		writeError(w, http.StatusInternalServerError, "archive failed")
		return
	}
	h.Bus.Publish(events.ChannelArchived(workspaceID, archived))
	w.WriteHeader(http.StatusNoContent)
}

// ChannelMemberResponse is the wire shape for a channel_member row.
type ChannelMemberResponse struct {
	ID                     string  `json:"id"`
	ChannelID              string  `json:"channel_id"`
	MemberType             string  `json:"member_type"`
	MemberID               string  `json:"member_id"`
	SubscribeMode          *string `json:"subscribe_mode"`
	LastRepliedAt          *string `json:"last_replied_at"`
	ProviderSessionID      *string `json:"provider_session_id"`
	LastKnownGoodSessionID *string `json:"last_known_good_session_id"`
	JoinedAt               string  `json:"joined_at"`
}

func channelMemberToResponse(m db.ChannelMember) ChannelMemberResponse {
	return ChannelMemberResponse{
		ID:                     uuidToString(m.ID),
		ChannelID:              uuidToString(m.ChannelID),
		MemberType:             m.MemberType,
		MemberID:               uuidToString(m.MemberID),
		SubscribeMode:          textToPtr(m.SubscribeMode),
		LastRepliedAt:          timestampToPtr(m.LastRepliedAt),
		ProviderSessionID:      textToPtr(m.ProviderSessionID),
		LastKnownGoodSessionID: textToPtr(m.LastKnownGoodSessionID),
		JoinedAt:               timestampToString(m.JoinedAt),
	}
}

// loadWorkspaceChannel fetches a channel and confirms it belongs to the workspace.
// On failure writes an HTTP error and returns (zero, false).
func (h *Handler) loadWorkspaceChannel(w http.ResponseWriter, r *http.Request, channelID, workspaceID pgtype.UUID) (db.Channel, bool) {
	c, err := h.Queries.GetChannelByID(r.Context(), db.GetChannelByIDParams{
		ID:          channelID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "channel not found")
			return db.Channel{}, false
		}
		writeError(w, http.StatusInternalServerError, "channel lookup failed")
		return db.Channel{}, false
	}
	return c, true
}

// parseMemberRef splits "member:<uuid>" or "agent:<uuid>" into kind and id.
func parseMemberRef(s string) (kind string, id string, ok bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	switch parts[0] {
	case "member", "agent":
		return parts[0], parts[1], true
	}
	return "", "", false
}

type PutChannelMemberRequest struct {
	SubscribeMode *string `json:"subscribe_mode"`
}

func (h *Handler) ListChannelMembers(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	// Confirm channel belongs to workspace; 404 if not.
	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	// Private/group_dm: only members can enumerate the member list. Same gate
	// as GetChannel; "404 not found" rather than 403 to avoid leaking existence.
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}
	rows, err := h.Queries.ListChannelMembers(r.Context(), channelUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	resp := make([]ChannelMemberResponse, len(rows))
	for i, m := range rows {
		resp[i] = channelMemberToResponse(m)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) PutChannelMember(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	kind, idStr, ok := parseMemberRef(chi.URLParam(r, "memberRef"))
	if !ok {
		writeError(w, http.StatusBadRequest, "memberRef must be member:<uuid> or agent:<uuid>")
		return
	}
	memberUUID, ok := parseUUIDOrBadRequest(w, idStr, "memberRef id")
	if !ok {
		return
	}
	// Confirm channel belongs to workspace.
	if _, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID); !ok {
		return
	}
	// Verify the target member/agent belongs to this workspace. channel_member.member_id
	// has no FK (polymorphic), so without this check a caller could insert rows
	// pointing at members from other workspaces.
	if kind == "agent" {
		// Agent must exist in this workspace.
		if _, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{
			ID:          memberUUID,
			WorkspaceID: workspaceUUID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusBadRequest, "target agent not found in this workspace")
				return
			}
			writeError(w, http.StatusInternalServerError, "agent lookup failed")
			return
		}
	} else {
		// Human-member workspace verification.
		target, err := h.Queries.GetMember(r.Context(), memberUUID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusBadRequest, "target member not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "member lookup failed")
			return
		}
		if uuidToString(target.WorkspaceID) != workspaceID {
			writeError(w, http.StatusBadRequest, "target member belongs to a different workspace")
			return
		}
	}
	var req PutChannelMemberRequest
	// Body is optional — empty body means "just upsert with no subscribe_mode override".
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.SubscribeMode != nil {
		switch *req.SubscribeMode {
		case "mention_only", "subscribe":
		default:
			writeError(w, http.StatusBadRequest, "subscribe_mode must be mention_only or subscribe")
			return
		}
	}

	row, err := h.Queries.UpsertChannelMember(r.Context(), db.UpsertChannelMemberParams{
		ChannelID:     channelUUID,
		MemberType:    kind,
		MemberID:      memberUUID,
		SubscribeMode: ptrToText(req.SubscribeMode),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "upsert failed")
		return
	}
	h.Bus.Publish(events.ChannelMemberAdded(workspaceID, row))
	writeJSON(w, http.StatusOK, channelMemberToResponse(row))
}

func (h *Handler) DeleteChannelMember(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	kind, idStr, ok := parseMemberRef(chi.URLParam(r, "memberRef"))
	if !ok {
		writeError(w, http.StatusBadRequest, "memberRef must be member:<uuid> or agent:<uuid>")
		return
	}
	memberUUID, ok := parseUUIDOrBadRequest(w, idStr, "memberRef id")
	if !ok {
		return
	}
	// Confirm channel belongs to workspace.
	if _, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID); !ok {
		return
	}
	if err := h.Queries.RemoveChannelMember(r.Context(), db.RemoveChannelMemberParams{
		ChannelID: channelUUID, MemberType: kind, MemberID: memberUUID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	h.Bus.Publish(events.ChannelMemberRemoved(workspaceID, uuidToString(channelUUID), kind, idStr))
	w.WriteHeader(http.StatusNoContent)
}

// ChannelMessageMention represents a mention reference (member or agent) within a message.
type ChannelMessageMention struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// ChannelMessageResponse is the wire shape for a channel_message row.
type ChannelMessageResponse struct {
	ID                string                   `json:"id"`
	ChannelID         string                   `json:"channel_id"`
	AuthorType        string                   `json:"author_type"`
	AuthorID          string                   `json:"author_id"`
	Body              string                   `json:"body"`
	ParentMessageID   *string                  `json:"parent_message_id"`
	Mentions          []ChannelMessageMention  `json:"mentions"`
	ReplyCount        int32                    `json:"reply_count"`
	LastReplyAt       *string                  `json:"last_reply_at"`
	ReplyParticipants []ChannelMessageMention  `json:"reply_participants"`
	DeliveryStatus    string                   `json:"delivery_status"`
	FailureReason     *string                  `json:"failure_reason"`
	TaskID            *string                  `json:"task_id"`
	CreatedAt         string                   `json:"created_at"`
	EditedAt          *string                  `json:"edited_at"`
	Reactions         []ChannelReactionResponse `json:"reactions"`
}

// ChannelReactionResponse is the wire shape for a channel_message_reaction row.
type ChannelReactionResponse struct {
	ID          string `json:"id"`
	MessageID   string `json:"message_id"`
	ReactorType string `json:"reactor_type"`
	ReactorID   string `json:"reactor_id"`
	Emoji       string `json:"emoji"`
	CreatedAt   string `json:"created_at"`
}

func channelMessageToResponse(m db.ChannelMessage) ChannelMessageResponse {
	out := ChannelMessageResponse{
		ID:                uuidToString(m.ID),
		ChannelID:         uuidToString(m.ChannelID),
		AuthorType:        m.AuthorType,
		AuthorID:          uuidToString(m.AuthorID),
		Body:              m.Body,
		ParentMessageID:   uuidToPtr(m.ParentMessageID),
		ReplyCount:        m.ReplyCount,
		LastReplyAt:       timestampToPtr(m.LastReplyAt),
		DeliveryStatus:    m.DeliveryStatus,
		FailureReason:     textToPtr(m.FailureReason),
		TaskID:            uuidToPtr(m.TaskID),
		CreatedAt:         timestampToString(m.CreatedAt),
		EditedAt:          timestampToPtr(m.EditedAt),
		Mentions:          []ChannelMessageMention{},
		ReplyParticipants: []ChannelMessageMention{},
		Reactions:         []ChannelReactionResponse{},
	}
	if len(m.Mentions) > 0 {
		_ = json.Unmarshal(m.Mentions, &out.Mentions)
		if out.Mentions == nil {
			out.Mentions = []ChannelMessageMention{}
		}
	}
	if len(m.ReplyParticipants) > 0 {
		_ = json.Unmarshal(m.ReplyParticipants, &out.ReplyParticipants)
		if out.ReplyParticipants == nil {
			out.ReplyParticipants = []ChannelMessageMention{}
		}
	}
	return out
}

func channelReactionToResponse(r db.ChannelMessageReaction) ChannelReactionResponse {
	return ChannelReactionResponse{
		ID:          uuidToString(r.ID),
		MessageID:   uuidToString(r.MessageID),
		ReactorType: r.ReactorType,
		ReactorID:   uuidToString(r.ReactorID),
		Emoji:       r.Emoji,
		CreatedAt:   timestampToString(r.CreatedAt),
	}
}

// attachReactionsToMessages fetches every reaction for the given message rows
// in one round-trip and attaches them to each response. Empty input returns
// the responses unchanged with empty Reactions slices (already initialized in
// channelMessageToResponse). On query error we log and return the responses
// without reactions — a missing reaction list shouldn't fail the message
// fetch.
func (h *Handler) attachReactionsToMessages(ctx context.Context, msgs []db.ChannelMessage, out []ChannelMessageResponse) []ChannelMessageResponse {
	if len(msgs) == 0 {
		return out
	}
	ids := make([]pgtype.UUID, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	rows, err := h.Queries.ListReactionsForMessages(ctx, ids)
	if err != nil {
		slog.Warn("attach reactions: list query failed", "error", err)
		return out
	}
	byID := make(map[string][]ChannelReactionResponse, len(out))
	for _, r := range rows {
		key := uuidToString(r.MessageID)
		byID[key] = append(byID[key], channelReactionToResponse(r))
	}
	for i, resp := range out {
		if list, ok := byID[resp.ID]; ok {
			out[i].Reactions = list
		}
	}
	return out
}

// SendChannelMessageRequest is the request body for sending a channel message.
type SendChannelMessageRequest struct {
	Body            string  `json:"body"`
	ParentMessageID *string `json:"parent_message_id"`
}

func (h *Handler) SendChannelMessage(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	// Visibility: private/group_dm channels reject non-members with 404 (mirrors
	// GetChannel's existence-non-leak; we don't want to confirm channel existence
	// to non-members via the send endpoint).
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}

	var req SendChannelMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeError(w, http.StatusBadRequest, "body must not be empty")
		return
	}

	var parent pgtype.UUID
	if req.ParentMessageID != nil && *req.ParentMessageID != "" {
		pu, parseOK := parseUUIDOrBadRequest(w, *req.ParentMessageID, "parent_message_id")
		if !parseOK {
			return
		}
		parent = pu
	}

	mentionsJSON := []byte("[]")
	if tokens := extractMentionTokens(req.Body); len(tokens) > 0 {
		rows, err := h.Queries.ResolveWorkspaceMentions(r.Context(), db.ResolveWorkspaceMentionsParams{
			WorkspaceID: workspaceUUID,
			AgentNames:  tokens,
			MemberNames: tokens,
		})
		if err != nil {
			// Non-fatal: store empty mentions and continue. Matches the codebase's
			// chat.go / invitation.go convention of logging Warn on non-fatal
			// handler-path errors rather than dropping silently.
			slog.Warn("channel mention resolution failed; storing empty mentions",
				"workspace_id", workspaceID, "error", err)
		} else if len(rows) > 0 {
			type m struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			ms := make([]m, 0, len(rows))
			for _, row := range rows {
				ms = append(ms, m{Type: row.Type, ID: uuidToString(row.ID)})
			}
			mentionsJSON, _ = json.Marshal(ms)
		}
	}

	msg, err := h.Queries.InsertChannelMessage(r.Context(), db.InsertChannelMessageParams{
		ChannelID:       channelUUID,
		AuthorType:      "member",
		AuthorID:        caller.ID,
		Body:            req.Body,
		ParentMessageID: parent,
		Mentions:        mentionsJSON,
		DeliveryStatus:  "complete",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to send message")
		return
	}
	h.Bus.Publish(events.ChannelMessageCreated(workspaceID, msg))

	if parent.Valid {
		// Thread reply: roll up the parent's reply_count / last_reply_at /
		// reply_participants so the main-timeline summary stays in sync, and
		// emit channel:thread:rollup so other tabs refresh the participant
		// strip without a refetch round-trip. Failures here are non-fatal —
		// the reply itself is already persisted; readers can recover the
		// rollup on the next thread fetch.
		rollup, rollupErr := h.Queries.BumpChannelThreadRollup(r.Context(), db.BumpChannelThreadRollupParams{
			ParticipantType: "member",
			ParticipantID:   caller.ID,
			ParentID:        parent,
		})
		if rollupErr != nil {
			slog.Warn("channel thread rollup bump failed",
				"channel_id", uuidToString(channelUUID),
				"parent_id", uuidToString(parent),
				"error", rollupErr)
		} else {
			var lastReply *string
			if rollup.LastReplyAt.Valid {
				s := rollup.LastReplyAt.Time.Format(time.RFC3339Nano)
				lastReply = &s
			}
			h.Bus.Publish(events.ChannelThreadRollup(
				workspaceID,
				uuidToString(rollup.ChannelID),
				uuidToString(rollup.ID),
				rollup.ReplyCount,
				lastReply,
				rollup.ReplyParticipants,
			))
		}
	}

	if h.ChannelDispatcher != nil {
		if err := h.ChannelDispatcher.Dispatch(r.Context(), msg); err != nil {
			slog.Error("channel dispatcher failed",
				"channel_id", uuidToString(channelUUID), "error", err)
			// Don't fail the request — the message is already saved.
		}
	}

	writeJSON(w, http.StatusCreated, channelMessageToResponse(msg))
}

// GetChannelThread returns the parent message + all replies for a thread,
// chronological order. Visibility check mirrors GetChannel/SendChannelMessage:
// non-public channels reject non-members with 404 to avoid leaking existence.
//
// 404 (not 400) when the parent isn't found OR doesn't belong to this channel —
// from the caller's perspective both look identical, so we don't distinguish.
func (h *Handler) GetChannelThread(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	parentUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "parentID"), "parentID")
	if !ok {
		return
	}

	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}

	rows, err := h.Queries.GetChannelThread(r.Context(), parentUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch thread")
		return
	}
	if len(rows) == 0 {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}
	// Ensure the returned messages actually belong to this channel — guards
	// against a parentID from a different channel sneaking through the URL.
	if uuidToString(rows[0].ChannelID) != uuidToString(channelUUID) {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}

	out := make([]ChannelMessageResponse, 0, len(rows))
	for _, m := range rows {
		out = append(out, channelMessageToResponse(m))
	}
	out = h.attachReactionsToMessages(r.Context(), rows, out)
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) ListChannelMessages(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}

	limit := int32(50)
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 200 {
			writeError(w, http.StatusBadRequest, "invalid limit parameter; expected integer in [1,200]")
			return
		}
		limit = int32(n)
	}
	var cursor pgtype.Timestamptz
	if cs := r.URL.Query().Get("cursor"); cs != "" {
		// Cursor format matches what timestampToString emits (time.RFC3339).
		t, err := time.Parse(time.RFC3339, cs)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid cursor parameter; expected RFC3339 format")
			return
		}
		cursor = pgtype.Timestamptz{Time: t, Valid: true}
	}
	rows, err := h.Queries.ListChannelMainMessages(r.Context(), db.ListChannelMainMessagesParams{
		ChannelID:       channelUUID,
		CursorCreatedAt: cursor,
		Limit:           limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	resp := make([]ChannelMessageResponse, len(rows))
	for i, m := range rows {
		resp[i] = channelMessageToResponse(m)
	}
	resp = h.attachReactionsToMessages(r.Context(), rows, resp)
	writeJSON(w, http.StatusOK, resp)
}

// AddChannelReactionRequest is the body for POST /api/channels/{id}/messages/{msgID}/reactions.
type AddChannelReactionRequest struct {
	Emoji string `json:"emoji"`
}

// AddChannelReaction inserts a reaction (member-authored only — agents can
// react via a future internal hook) and broadcasts channel:reaction:added.
// Idempotent: re-tapping the same emoji is a no-op that still returns 200
// with the existing row.
func (h *Handler) AddChannelReaction(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	msgUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "messageID"), "messageID")
	if !ok {
		return
	}

	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}

	// Validate (channel, message) consistency — the message must belong to
	// this channel. Mirrors GetChannelThread's cross-channel guard.
	msgRow, err := h.Queries.GetChannelMessageWithChannel(r.Context(), msgUUID)
	if err != nil {
		writeError(w, http.StatusNotFound, "message not found")
		return
	}
	if uuidToString(msgRow.ChannelID) != uuidToString(channelUUID) {
		writeError(w, http.StatusNotFound, "message not found")
		return
	}

	var req AddChannelReactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	emoji := strings.TrimSpace(req.Emoji)
	if emoji == "" || len(emoji) > 32 {
		writeError(w, http.StatusBadRequest, "emoji must be 1-32 chars")
		return
	}

	row, err := h.Queries.InsertChannelMessageReaction(r.Context(), db.InsertChannelMessageReactionParams{
		MessageID:   msgUUID,
		ReactorType: "member",
		ReactorID:   caller.ID,
		Emoji:       emoji,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to add reaction")
		return
	}
	h.Bus.Publish(events.ChannelReactionAdded(workspaceID, uuidToString(channelUUID), row))
	writeJSON(w, http.StatusOK, channelReactionToResponse(row))
}

// RemoveChannelReaction deletes a reaction (member-authored only) and
// broadcasts channel:reaction:removed. 404 when the reaction didn't exist.
func (h *Handler) RemoveChannelReaction(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	caller, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	msgUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "messageID"), "messageID")
	if !ok {
		return
	}
	emoji := chi.URLParam(r, "emoji")
	emoji = strings.TrimSpace(emoji)
	// Path-encoded emoji may contain UTF-8 bytes that decode to >32 chars
	// after URL-unescape; chi already decodes, so we apply the same length
	// guard as the add path to keep them symmetrical.
	if emoji == "" || len(emoji) > 32 {
		writeError(w, http.StatusBadRequest, "emoji must be 1-32 chars")
		return
	}

	c, ok := h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID)
	if !ok {
		return
	}
	if c.Kind != "public" {
		isMember, err := h.Queries.IsChannelMember(r.Context(), db.IsChannelMemberParams{
			ChannelID:  c.ID,
			MemberType: "member",
			MemberID:   caller.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "visibility check failed")
			return
		}
		if !isMember {
			writeError(w, http.StatusNotFound, "channel not found")
			return
		}
	}

	msgRow, err := h.Queries.GetChannelMessageWithChannel(r.Context(), msgUUID)
	if err != nil {
		writeError(w, http.StatusNotFound, "message not found")
		return
	}
	if uuidToString(msgRow.ChannelID) != uuidToString(channelUUID) {
		writeError(w, http.StatusNotFound, "message not found")
		return
	}

	rowsAffected, err := h.Queries.DeleteChannelMessageReaction(r.Context(), db.DeleteChannelMessageReactionParams{
		MessageID:   msgUUID,
		ReactorType: "member",
		ReactorID:   caller.ID,
		Emoji:       emoji,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove reaction")
		return
	}
	if rowsAffected == 0 {
		writeError(w, http.StatusNotFound, "reaction not found")
		return
	}
	h.Bus.Publish(events.ChannelReactionRemoved(
		workspaceID,
		uuidToString(channelUUID),
		uuidToString(msgUUID),
		"member",
		uuidToString(caller.ID),
		emoji,
	))
	w.WriteHeader(http.StatusNoContent)
}
