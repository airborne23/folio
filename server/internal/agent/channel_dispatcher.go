// Package agent provides dispatcher logic for routing channel messages to the
// appropriate agent task queue. This is distinct from server/pkg/agent, which
// contains the runtime interface for executing agent prompts.
package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/airborne23/folio/server/pkg/db/generated"
)

// mentionAttemptRe matches any @-token shape, regardless of whether the
// token resolves to a real user/agent. The handler-side regex
// (mentionTokenRe in handler/channel.go) has the same shape and is kept
// in sync deliberately: handler uses it to extract tokens for DB
// resolution, the dispatcher uses it to detect *intent* — even an
// unresolved "@e2e-user" (typo, deleted member, multi-word name) signals
// the user was directing the message at someone specific, so
// subscribe-mode agents should not chime in.
var mentionAttemptRe = regexp.MustCompile(`@[\p{L}\p{N}][\p{L}\p{N}_\-]*`)

// mentionAllRe matches the literal "@all" broadcast token. We special-
// case it because the user's intent ("everyone respond") is the
// opposite of what mentionAttemptRe assumes ("someone specific got
// called out, others stay quiet"). Without this, "@all 大家来介绍下"
// resolves to zero agent mentions but trips hasExplicitMention, which
// suppresses every subscribe-mode agent — the exact wrong behavior.
//
// Word boundaries are explicit (start-or-non-token char on both sides)
// so "@allies" / "@allbright" don't trip the broadcast path.
var mentionAllRe = regexp.MustCompile(`(^|[^\p{L}\p{N}_\-])@all($|[^\p{L}\p{N}_\-])`)

// TaskEnqueuer is the seam between the dispatcher and the actual
// agent_task_queue insert. The interface lets unit tests verify dispatch
// decisions without exercising a real DB write path.
type TaskEnqueuer interface {
	Enqueue(ctx context.Context, p EnqueueParams) error
}

// EnqueueParams holds the inputs for a single agent_task_queue insert.
type EnqueueParams struct {
	AgentID   pgtype.UUID
	ChannelID pgtype.UUID
	Context   json.RawMessage
	Priority  int32
}

const (
	PriorityNormal int32 = 0
	PriorityHigh   int32 = 100
)

// ChannelDispatcher decides which agents should respond to a new channel
// message and enqueues agent_task_queue rows for each.
type ChannelDispatcher struct {
	q   *db.Queries
	enq TaskEnqueuer
}

// NewChannelDispatcher constructs a ChannelDispatcher backed by q and enq.
func NewChannelDispatcher(q *db.Queries, enq TaskEnqueuer) *ChannelDispatcher {
	return &ChannelDispatcher{q: q, enq: enq}
}

type channelMention struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// Dispatch enqueues agent_task_queue rows for each agent in the channel that
// should respond to msg.
//
// Routing rules (per-agent):
//   - Self-reply guard always skips the authoring agent.
//   - @mentioned agents always fire at HIGH priority, bypassing all gates.
//     This is the "I'm asking you directly" semantics.
//   - subscribe_mode=="subscribe" agents (or default_subscribe_mode when the
//     per-row override is NULL) fire at NORMAL priority, gated by:
//       * per-agent cooldown:  now - last_replied_at < channel.agent_cooldown_ms
//       * channel-wide gate:   consecutive_agent_turns >= max_consecutive_agent_turns
//   - subscribe_mode=="mention_only" non-mentioned agents are always skipped.
//
// The channel-wide gate counter is reset to 0 here when a human posts; the
// matching increment lives in the streaming reply path (C.4) so we count
// completed agent turns rather than dispatched ones.
func (d *ChannelDispatcher) Dispatch(ctx context.Context, msg db.ChannelMessage) error {
	// Anchor: when an *agent* reply triggers re-dispatch, the suppression
	// decision must reference the user's most recent message — not the
	// agent's reply. Otherwise a directed @-chain ("user @A → A replies
	// (no @) → re-dispatch sees no @ → subscribe agent B chimes in")
	// breaks the directedness. For member-authored triggers the anchor
	// is the message itself.
	anchorMsg := msg
	if msg.AuthorType == "agent" {
		if recent, err := d.q.GetMostRecentMemberMessageInChannel(ctx, msg.ChannelID); err == nil {
			anchorMsg = recent
		}
		// If lookup fails (no member message yet, or DB error) we fall
		// back to using msg itself — the gate-counter / cooldown checks
		// below still bound runaway loops, so the worst case is a
		// permissive subscribe fan-out, not silent failure.
	}

	mentioned := map[string]bool{}
	if len(anchorMsg.Mentions) > 0 {
		var ms []channelMention
		if err := json.Unmarshal(anchorMsg.Mentions, &ms); err == nil {
			for _, m := range ms {
				if m.Type == "agent" {
					mentioned[m.ID] = true
				}
			}
		}
	}
	// hasExplicitMention is the suppression signal for subscribe-mode
	// agents who weren't named. We read it off the anchor body — not off
	// the resolved mentions array — because the user's *intent* matters
	// more than whether the token resolved. A typo'd handle, a
	// multi-word name the regex couldn't tokenize ("@E2E User" stops at
	// "@E2E"), or an @ pointing at a since-deleted member all leave the
	// resolved-mentions array empty but the user still meant a directed
	// call-out. Counting any @-shaped token captures that intent.
	hasExplicitMention := mentionAttemptRe.MatchString(anchorMsg.Body)

	// isMentionAll inverts the suppression: @all means "everyone
	// respond, including subscribe-mode agents who weren't otherwise
	// named". Without this branch, hasExplicitMention=true would silence
	// every subscribe agent on a broadcast — the exact opposite of the
	// user's intent. Treated like a directed mention: HIGH priority,
	// gates bypassed for the human-trigger case (the agent-trigger case
	// still goes through cooldown / max-turns to bound broadcast loops).
	isMentionAll := mentionAllRe.MatchString(anchorMsg.Body)

	if msg.AuthorType == "member" {
		if err := d.q.ResetConsecutiveAgentTurns(ctx, msg.ChannelID); err != nil {
			slog.Warn("channel dispatcher: reset consecutive turns failed",
				"channel_id", uuidToString(msg.ChannelID), "error", err)
		}
	}

	rows, err := d.q.ListChannelAgentMembers(ctx, msg.ChannelID)
	if err != nil {
		return err
	}

	now := time.Now()
	for _, m := range rows {
		agentID := uuidToString(m.MemberID)

		if msg.AuthorType == "agent" && uuidToString(msg.AuthorID) == agentID {
			continue
		}

		isMentioned := mentioned[agentID]
		isAddressed := isMentioned || isMentionAll
		mode := effectiveSubscribeMode(m)
		priority := PriorityHigh
		if !isAddressed {
			if mode != "subscribe" {
				continue
			}
			// Mention-suppression: when the message names anyone — agent
			// or human member — subscribe-mode agents who weren't named
			// stay quiet. Slack-style: @ is a directed call-out;
			// subscribe is "listen when no one in particular was named".
			// Counting *any* @ matters because "@some-human 你是谁" is a
			// directed question to that human, not an open invitation
			// for every subscribe agent to chime in.
			if hasExplicitMention {
				continue
			}
			priority = PriorityNormal
		}
		// Cooldown + max-turns gates are anti-runaway-loop guards: they
		// bound multi-agent chains so "@A @B 你俩聊" doesn't ping-pong
		// forever. Apply on agent-authored triggers (re-dispatch)
		// REGARDLESS of mention status — earlier the gates were inside
		// the !isMentioned branch and mentioned agents bypassed
		// everything, producing 9-turn chains with no cap. Member-
		// authored triggers always reset the floor (human is in
		// control), so gates only matter for the agent → agent path.
		if msg.AuthorType == "agent" {
			if m.MaxConsecutiveAgentTurns > 0 && m.ConsecutiveAgentTurns >= m.MaxConsecutiveAgentTurns {
				continue
			}
			if m.AgentCooldownMs > 0 && m.LastRepliedAt.Valid {
				if now.Sub(m.LastRepliedAt.Time) < time.Duration(m.AgentCooldownMs)*time.Millisecond {
					continue
				}
			}
		}

		ctxJSON, _ := json.Marshal(map[string]any{
			"channel_id":          uuidToString(msg.ChannelID),
			"trigger_message_id":  uuidToString(msg.ID),
			"parent_message_id":   nullableUUIDString(msg.ParentMessageID),
			"provider_session_id": nullableTextValue(m.ProviderSessionID),
		})
		if err := d.enq.Enqueue(ctx, EnqueueParams{
			AgentID:   m.MemberID,
			ChannelID: msg.ChannelID,
			Context:   ctxJSON,
			Priority:  priority,
		}); err != nil {
			slog.Warn("channel dispatcher: enqueue failed",
				"channel_id", uuidToString(msg.ChannelID),
				"agent_id", agentID,
				"error", err,
			)
		}
	}
	return nil
}

// effectiveSubscribeMode returns the per-agent override when set, otherwise
// the channel default. Both columns use the same vocabulary
// ("subscribe" | "mention_only").
func effectiveSubscribeMode(m db.ListChannelAgentMembersRow) string {
	if m.SubscribeMode.Valid && m.SubscribeMode.String != "" {
		return m.SubscribeMode.String
	}
	return m.DefaultSubscribeMode
}

func uuidToString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	return uuid.UUID(u.Bytes).String()
}

func nullableUUIDString(u pgtype.UUID) *string {
	if !u.Valid {
		return nil
	}
	s := uuid.UUID(u.Bytes).String()
	return &s
}

func nullableTextValue(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}
