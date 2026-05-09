package events

import (
	"encoding/json"

	db "github.com/airborne23/folio/server/pkg/db/generated"
)

// Channel event kind constants. Folio's bus uses colon-separated event types
// (see server/pkg/protocol/events.go and packages/core/types/events.ts) — we
// follow that convention with multi-colon nesting for sub-namespaces.
const (
	KindChannelCreated          = "channel:created"
	KindChannelUpdated          = "channel:updated"
	KindChannelArchived         = "channel:archived"
	KindChannelMemberAdded      = "channel:member:added"
	KindChannelMemberRemoved    = "channel:member:removed"
	KindChannelMessageCreated   = "channel:message:created"
	KindChannelMessagePatched   = "channel:message:patched"
	KindChannelMessageCompleted = "channel:message:completed"
	KindChannelThreadRollup     = "channel:thread:rollup"
	KindChannelReactionAdded    = "channel:reaction:added"
	KindChannelReactionRemoved  = "channel:reaction:removed"
	// KindChannelAgentThinking fires when an agent has been dispatched in
	// a channel; clients render a "<name> is replying…" indicator while
	// the agent runs. "End" is implicit — when the matching
	// channel:message:created arrives for the same (channel_id, agent_id)
	// the client removes that agent from the indicator. A defensive local
	// timeout covers missed-event cases.
	KindChannelAgentThinking = "channel:agent:thinking"
)

// ChannelAgentThinkingPayload identifies the (channel, agent) pair that is
// now in flight. workspace_id rides on the envelope (Event.WorkspaceID).
// ParentMessageID is set when the dispatch was triggered inside a thread —
// the client uses it to scope the "is replying…" indicator to the right
// surface (main channel vs thread drawer). Empty string means main-channel.
type ChannelAgentThinkingPayload struct {
	ChannelID       string `json:"channel_id"`
	AgentID         string `json:"agent_id"`
	ParentMessageID string `json:"parent_message_id,omitempty"`
}

// ChannelMemberRemovedPayload carries the identity of the member that was
// removed from a channel. Used after the DELETE has already committed and the
// db.ChannelMember row is no longer available.
type ChannelMemberRemovedPayload struct {
	ChannelID  string `json:"channel_id"`
	MemberType string `json:"member_type"`
	MemberID   string `json:"member_id"`
}

// ChannelMessagePatchedPayload carries a partial body delta produced during
// streaming agent replies (phase C.4).
type ChannelMessagePatchedPayload struct {
	ChannelID      string `json:"channel_id"`
	MessageID      string `json:"message_id"`
	BodyDelta      string `json:"body_delta"`
	DeliveryStatus string `json:"delivery_status"`
}

// ChannelThreadRollupPayload carries the updated thread aggregate fields for a
// parent message after a reply is created or removed. ReplyParticipants is the
// raw JSONB blob from channel_message — clients use it directly to render the
// participant strip without an extra refetch.
type ChannelThreadRollupPayload struct {
	ChannelID          string          `json:"channel_id"`
	ParentMessageID    string          `json:"parent_message_id"`
	ReplyCount         int32           `json:"reply_count"`
	LastReplyAt        *string         `json:"last_reply_at"`
	ReplyParticipants  json.RawMessage `json:"reply_participants"`
}

// ChannelReactionAddedPayload wraps the inserted reaction row with an explicit
// channel_id field. The bare db.ChannelMessageReaction row only carries
// message_id, but the WS client needs channel_id to invalidate
// channelKeys.messages(channelID); we pass it alongside.
type ChannelReactionAddedPayload struct {
	ChannelID  string                   `json:"channel_id"`
	Reaction   db.ChannelMessageReaction `json:"reaction"`
}

// ChannelReactionRemovedPayload carries the identity of the reaction that was
// removed. Used after the DELETE has already committed.
type ChannelReactionRemovedPayload struct {
	ChannelID   string `json:"channel_id"`
	MessageID   string `json:"message_id"`
	ReactorType string `json:"reactor_type"`
	ReactorID   string `json:"reactor_id"`
	Emoji       string `json:"emoji"`
}

// ChannelCreated builds an event for a newly created channel.
func ChannelCreated(workspaceID string, c db.Channel) Event {
	return Event{
		Type:        KindChannelCreated,
		WorkspaceID: workspaceID,
		Payload:     c,
	}
}

// ChannelUpdated builds an event for a channel that was updated.
func ChannelUpdated(workspaceID string, c db.Channel) Event {
	return Event{
		Type:        KindChannelUpdated,
		WorkspaceID: workspaceID,
		Payload:     c,
	}
}

// ChannelArchived builds an event for a channel that was archived.
func ChannelArchived(workspaceID string, c db.Channel) Event {
	return Event{
		Type:        KindChannelArchived,
		WorkspaceID: workspaceID,
		Payload:     c,
	}
}

// ChannelMemberAdded builds an event for a member that joined a channel. The
// channel id is read off the row (m.ChannelID), so callers don't pass it
// separately.
func ChannelMemberAdded(workspaceID string, m db.ChannelMember) Event {
	return Event{
		Type:        KindChannelMemberAdded,
		WorkspaceID: workspaceID,
		Payload:     m,
	}
}

// ChannelMemberRemoved builds an event for a member that left or was removed
// from a channel. Parameters are passed individually because the db row is
// typically unavailable after a DELETE.
func ChannelMemberRemoved(workspaceID string, channelID string, memberType string, memberID string) Event {
	return Event{
		Type:        KindChannelMemberRemoved,
		WorkspaceID: workspaceID,
		Payload: ChannelMemberRemovedPayload{
			ChannelID:  channelID,
			MemberType: memberType,
			MemberID:   memberID,
		},
	}
}

// ChannelMessageCreated builds an event for a new channel message.
func ChannelMessageCreated(workspaceID string, m db.ChannelMessage) Event {
	return Event{
		Type:        KindChannelMessageCreated,
		WorkspaceID: workspaceID,
		Payload:     m,
	}
}

// ChannelMessagePatched builds an event carrying a partial body delta during
// streaming agent replies. bodyDelta is the incremental text token;
// deliveryStatus is the current delivery_status value of the message row.
func ChannelMessagePatched(workspaceID string, channelID string, messageID string, bodyDelta string, deliveryStatus string) Event {
	return Event{
		Type:        KindChannelMessagePatched,
		WorkspaceID: workspaceID,
		Payload: ChannelMessagePatchedPayload{
			ChannelID:      channelID,
			MessageID:      messageID,
			BodyDelta:      bodyDelta,
			DeliveryStatus: deliveryStatus,
		},
	}
}

// ChannelMessageCompleted builds an event for a channel message whose
// streaming delivery has finished (final state).
func ChannelMessageCompleted(workspaceID string, m db.ChannelMessage) Event {
	return Event{
		Type:        KindChannelMessageCompleted,
		WorkspaceID: workspaceID,
		Payload:     m,
	}
}

// ChannelThreadRollup builds an event carrying the updated thread aggregate
// fields for a parent message. replyParticipants is the raw JSONB blob from
// channel_message.reply_participants (callers may pass m.ReplyParticipants
// directly since []byte assigns to json.RawMessage).
func ChannelThreadRollup(workspaceID string, channelID string, parentMessageID string, replyCount int32, lastReplyAt *string, replyParticipants json.RawMessage) Event {
	return Event{
		Type:        KindChannelThreadRollup,
		WorkspaceID: workspaceID,
		Payload: ChannelThreadRollupPayload{
			ChannelID:         channelID,
			ParentMessageID:   parentMessageID,
			ReplyCount:        replyCount,
			LastReplyAt:       lastReplyAt,
			ReplyParticipants: replyParticipants,
		},
	}
}

// ChannelReactionAdded builds an event for a reaction that was added to a
// channel message. channelID is required because db.ChannelMessageReaction
// only carries message_id; the WS client needs channel_id to invalidate the
// right messages query (channelKeys.messages(channelID)).
func ChannelReactionAdded(workspaceID string, channelID string, r db.ChannelMessageReaction) Event {
	return Event{
		Type:        KindChannelReactionAdded,
		WorkspaceID: workspaceID,
		Payload: ChannelReactionAddedPayload{
			ChannelID: channelID,
			Reaction:  r,
		},
	}
}

// ChannelReactionRemoved builds an event for a reaction that was removed from
// a channel message. Parameters are passed individually because the db row is
// typically unavailable after a DELETE.
func ChannelReactionRemoved(workspaceID string, channelID string, messageID string, reactorType string, reactorID string, emoji string) Event {
	return Event{
		Type:        KindChannelReactionRemoved,
		WorkspaceID: workspaceID,
		Payload: ChannelReactionRemovedPayload{
			ChannelID:   channelID,
			MessageID:   messageID,
			ReactorType: reactorType,
			ReactorID:   reactorID,
			Emoji:       emoji,
		},
	}
}

// ChannelAgentThinking signals that an agent has been dispatched in this
// channel and the UI should display a "<agent> is replying…" indicator.
// parentMessageID is the empty string for main-channel dispatches, or the
// thread parent UUID when the dispatch was triggered by a reply inside a
// thread — used by clients to scope the indicator surface.
func ChannelAgentThinking(workspaceID string, channelID string, agentID string, parentMessageID string) Event {
	return Event{
		Type:        KindChannelAgentThinking,
		WorkspaceID: workspaceID,
		Payload: ChannelAgentThinkingPayload{
			ChannelID:       channelID,
			AgentID:         agentID,
			ParentMessageID: parentMessageID,
		},
	}
}
