-- name: CreateChannel :one
INSERT INTO channel (workspace_id, name, kind, topic, creator_member_id,
                     default_subscribe_mode, agent_cooldown_ms, max_consecutive_agent_turns)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: GetChannelByID :one
SELECT * FROM channel WHERE id = $1 AND workspace_id = $2;

-- name: ListChannelsForMember :many
-- Returns: public + private-where-caller-is-member + group_dm-where-caller-is-member.
SELECT c.* FROM channel c
WHERE c.workspace_id = $1
  AND c.archived_at IS NULL
  AND (
    c.kind = 'public'
    OR EXISTS (
      SELECT 1 FROM channel_member cm
      WHERE cm.channel_id = c.id
        AND cm.member_type = 'member'
        AND cm.member_id = $2
    )
  )
ORDER BY c.created_at ASC;

-- name: UpdateChannel :one
-- Caller must reject `name` updates on group_dm channels at the handler layer:
-- the channel_name_required_unless_group_dm CHECK will otherwise raise SQLSTATE
-- 23514. `topic` uses COALESCE so partial PATCHes leave it untouched; clearing
-- the topic is not currently supported (add a dedicated query if needed).
UPDATE channel SET
    name = COALESCE(sqlc.narg('name'), name),
    topic = COALESCE(sqlc.narg('topic'), topic),
    default_subscribe_mode = COALESCE(sqlc.narg('default_subscribe_mode'), default_subscribe_mode),
    agent_cooldown_ms = COALESCE(sqlc.narg('agent_cooldown_ms'), agent_cooldown_ms),
    max_consecutive_agent_turns = COALESCE(sqlc.narg('max_consecutive_agent_turns'), max_consecutive_agent_turns),
    updated_at = now()
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: ArchiveChannel :one
-- Returns the archived row; pgx.ErrNoRows on not-found / wrong-workspace /
-- already-archived so the handler can map to 404.
UPDATE channel SET archived_at = now(), updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
RETURNING *;

-- name: ResetConsecutiveAgentTurns :exec
-- Channel IDs are globally unique UUIDs; workspace_id is intentionally omitted
-- so the channel dispatcher (which has only channel_id from the message) can call
-- this without carrying extra workspace context.
UPDATE channel SET consecutive_agent_turns = 0
WHERE id = $1;

-- name: IncrementConsecutiveAgentTurns :one
UPDATE channel SET consecutive_agent_turns = consecutive_agent_turns + 1
WHERE id = $1 AND workspace_id = $2
RETURNING consecutive_agent_turns, max_consecutive_agent_turns;

-- name: UpsertChannelMember :one
-- COALESCE preserves the existing subscribe_mode when the caller re-adds a
-- member without an explicit preference (empty body). Without this, the
-- ON CONFLICT branch would silently NULL out a previously-set value.
INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode)
VALUES ($1, $2, $3, $4)
ON CONFLICT (channel_id, member_type, member_id)
DO UPDATE SET subscribe_mode = COALESCE(EXCLUDED.subscribe_mode, channel_member.subscribe_mode)
RETURNING *;

-- name: RemoveChannelMember :exec
DELETE FROM channel_member
WHERE channel_id = $1 AND member_type = $2 AND member_id = $3;

-- name: ListChannelMembers :many
SELECT * FROM channel_member
WHERE channel_id = $1
ORDER BY joined_at ASC;

-- name: IsChannelMember :one
SELECT EXISTS(
  SELECT 1 FROM channel_member
  WHERE channel_id = $1 AND member_type = $2 AND member_id = $3
) AS is_member;

-- name: InsertChannelMessage :one
INSERT INTO channel_message (channel_id, author_type, author_id, body, parent_message_id, mentions, delivery_status, task_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: ListChannelMainMessages :many
-- Cursor-paginated newest-first. Pass NULL cursor to get the most recent page.
--
-- Filter: hide empty completed agent messages. When dispatcher fires a
-- subscribe-mode agent that decides to stay silent, the streaming
-- placeholder gets finalized with empty body. We drop those rows from the
-- timeline rather than render an empty agent bubble. Streaming and failed
-- rows are kept (the UI shows a typing indicator / error bubble respectively
-- — both of which are meaningful even with empty body).
SELECT * FROM channel_message
WHERE channel_id = $1
  AND parent_message_id IS NULL
  AND NOT (author_type = 'agent' AND delivery_status = 'complete' AND body = '')
  AND (sqlc.narg('cursor_created_at')::timestamptz IS NULL OR created_at < sqlc.narg('cursor_created_at'))
ORDER BY created_at DESC
LIMIT $2;

-- name: GetChannelMessage :one
SELECT * FROM channel_message WHERE id = $1;

-- name: ResolveWorkspaceMentions :many
-- Resolves any of the given handles (lowercased agent names or member display
-- names) to {type, id} tuples within the workspace. Two array params let us
-- search agent and member tables in one round-trip; both can carry the same
-- token list.
SELECT 'agent'::text AS type, a.id::uuid AS id
FROM agent a
WHERE a.workspace_id = sqlc.arg('workspace_id')::uuid
  AND lower(a.name) = ANY(sqlc.arg('agent_names')::text[])
  AND a.archived_at IS NULL
UNION ALL
SELECT 'member'::text AS type, m.id::uuid AS id
FROM member m
JOIN "user" u ON u.id = m.user_id
WHERE m.workspace_id = sqlc.arg('workspace_id')::uuid
  AND lower(u.name) = ANY(sqlc.arg('member_names')::text[])
;

-- name: ListChannelAgentMembers :many
-- All agent rows for a channel along with the channel's gate config and the
-- per-agent's last_replied_at + provider_session_id, so the dispatcher has
-- everything it needs to decide who fires.
SELECT cm.*,
       c.default_subscribe_mode,
       c.agent_cooldown_ms,
       c.consecutive_agent_turns,
       c.max_consecutive_agent_turns
FROM channel_member cm
JOIN channel c ON c.id = cm.channel_id
WHERE cm.channel_id = $1
  AND cm.member_type = 'agent';

-- name: UpdateAgentMemberAfterReply :exec
-- Called when an agent's reply lands; bumps last_replied_at and optionally
-- updates the per-(agent,channel) provider_session_id for resume.
UPDATE channel_member
SET last_replied_at = now(),
    provider_session_id = COALESCE(sqlc.narg('provider_session_id'), provider_session_id),
    last_known_good_session_id = COALESCE(sqlc.narg('last_known_good_session_id'), last_known_good_session_id)
WHERE channel_id = sqlc.arg('channel_id')
  AND member_type = 'agent'
  AND member_id = sqlc.arg('agent_id');

-- name: GetMostRecentMemberMessageInChannel :one
-- Used by the dispatcher's agent-reply re-dispatch path to anchor
-- mention-suppression decisions on the *user's* last message rather than
-- the agent's reply. Reasoning: when a user @-directs a question, the
-- entire follow-up chain (agent A → agent B → A again) should inherit
-- that directedness — subscribe-mode agents not named must not chime in
-- on the chain just because an agent's reply happens to contain no @.
SELECT * FROM channel_message
WHERE channel_id = $1 AND author_type = 'member'
ORDER BY created_at DESC
LIMIT 1;

-- name: ListRecentChannelHistory :many
-- Most recent N main-timeline messages for an agent prompt context. Returns
-- chronological order (oldest first) so the prompt reads naturally.
WITH recent AS (
    SELECT *
    FROM channel_message
    WHERE channel_id = $1
      AND parent_message_id IS NULL
    ORDER BY created_at DESC
    LIMIT $2
)
SELECT * FROM recent ORDER BY created_at ASC;

-- name: ListChannelThreadForPrompt :many
-- Parent message + all replies for a thread, chronological order.
SELECT * FROM channel_message
WHERE id = $1 OR parent_message_id = $1
ORDER BY created_at ASC;

-- name: GetChannelThread :many
-- API-facing thread fetch: parent message + all replies in chronological
-- order. Same SQL as ListChannelThreadForPrompt but kept separate so that
-- request-path filtering (e.g. dropping failed messages) can diverge from
-- the prompt-builder's needs without one breaking the other.
--
-- The empty-completed-agent filter mirrors ListChannelMainMessages so the
-- thread drawer doesn't surface empty bubbles from silent subscribe-mode
-- replies. The parent itself is always returned (id = parent_id branch is
-- the parent and is not author_type='agent' if the human kicked off the
-- thread; if it IS an agent thread-starter and that row is empty it'd be a
-- weird state but the filter would correctly drop it too).
SELECT * FROM channel_message
WHERE (id = sqlc.arg('parent_id') OR parent_message_id = sqlc.arg('parent_id'))
  AND NOT (author_type = 'agent' AND delivery_status = 'complete' AND body = '')
ORDER BY created_at ASC;

-- name: InsertChannelMessageReaction :one
-- Idempotent reaction insert: ON CONFLICT triggers a no-op UPDATE so RETURNING
-- still emits the row. Without that, ON CONFLICT DO NOTHING would not return
-- anything when the (message_id, reactor, emoji) tuple already existed, and
-- the caller would have to follow up with a SELECT — extra round-trip for the
-- common "double-tap an emoji" path.
INSERT INTO channel_message_reaction (message_id, reactor_type, reactor_id, emoji)
VALUES ($1, $2, $3, $4)
ON CONFLICT (message_id, reactor_type, reactor_id, emoji)
DO UPDATE SET emoji = EXCLUDED.emoji
RETURNING *;

-- name: DeleteChannelMessageReaction :execrows
-- Returns the affected row count so the caller can distinguish "removed an
-- existing reaction" (1) from "no such reaction" (0) and translate the
-- latter into a 404 — mirrors GetChannelMessage's not-found semantics.
DELETE FROM channel_message_reaction
WHERE message_id = $1
  AND reactor_type = $2
  AND reactor_id = $3
  AND emoji = $4;

-- name: ListReactionsForMessages :many
-- Batch fetch every reaction for a set of message_ids in one round-trip.
-- Used to attach reactions to the channel_message list / thread responses
-- without firing N+1 queries per row.
SELECT *
FROM channel_message_reaction
WHERE message_id = ANY(sqlc.arg('message_ids')::uuid[])
ORDER BY created_at ASC;

-- name: GetChannelMessageWithChannel :one
-- Used by reaction handlers to validate that {channelID}/messages/{msgID}
-- are consistent before mutating channel_message_reaction. Returns just the
-- channel_id and parent_message_id (no body) — that's all callers need.
SELECT id, channel_id, parent_message_id FROM channel_message WHERE id = $1;

-- name: InsertAgentChannelMessage :one
-- Single-shot agent reply insert: used by the daemon CompleteTask /
-- FailTask handlers to record the agent's outcome as one row at finalize
-- time. Replaces the older "create empty placeholder on StartTask, UPDATE
-- on finalize" flow — that flow caused parallel agents to render their
-- placeholders in created_at order while finishes happened in arbitrary
-- order, producing visible row-jump.
--
-- delivery_status is 'complete' on success, 'failed' on the FailTask path.
-- failure_reason is non-NULL only on failure.
INSERT INTO channel_message (
    channel_id, author_type, author_id, body, parent_message_id,
    mentions, delivery_status, failure_reason, task_id
)
VALUES ($1, 'agent', $2, $3, $4, '[]'::jsonb, $5, $6, $7)
RETURNING *;

-- name: BumpChannelThreadRollup :one
-- Called after a reply is inserted. Increments reply_count, advances
-- last_reply_at, and upserts the author into reply_participants without
-- duplicates. Returns the updated rollup fields so the caller can broadcast
-- a channel:thread:rollup event without a follow-up read.
--
-- The CASE-with-@> idiom checks containment first; appending blindly would
-- store every reply by the same author over and over, which the UI would
-- then have to dedup on render.
UPDATE channel_message
SET reply_count = reply_count + 1,
    last_reply_at = now(),
    reply_participants = CASE
        WHEN reply_participants @> jsonb_build_array(
            jsonb_build_object('type', sqlc.arg('participant_type')::text,
                               'id',   sqlc.arg('participant_id')::uuid)
        )
        THEN reply_participants
        ELSE reply_participants || jsonb_build_array(
            jsonb_build_object('type', sqlc.arg('participant_type')::text,
                               'id',   sqlc.arg('participant_id')::uuid)
        )
    END
WHERE id = sqlc.arg('parent_id')
RETURNING id, channel_id, reply_count, last_reply_at, reply_participants;

-- name: GetAgentDisplayInfoForPrompt :one
-- Agent's display name + workspace slug + workspace_id (single round-trip
-- replaces a follow-up GetAgent call; workspace_id is required for the
-- daemon-task isolation check downstream).
SELECT a.name AS agent_name, w.slug AS workspace_slug, a.workspace_id AS workspace_id
FROM agent a
JOIN workspace w ON w.id = a.workspace_id
WHERE a.id = $1;

-- name: GetChannelDisplayInfoForPrompt :one
SELECT c.id, c.name, c.kind, c.topic
FROM channel c
WHERE c.id = $1;

-- name: GetChannelWorkspaceID :one
-- Lightweight lookup used by ResolveTaskWorkspaceID for channel-context tasks.
-- Returns the channel's workspace_id without joining other tables.
SELECT workspace_id FROM channel WHERE id = $1;

-- name: PrepareAgentChannelMessage :one
-- Insert an empty placeholder for the agent's streaming reply. parent_message_id
-- is the task's threading scope (NULL for top-level replies).
INSERT INTO channel_message (
    channel_id, author_type, author_id, body, parent_message_id, mentions,
    delivery_status, task_id
)
VALUES ($1, 'agent', $2, '', $3, '[]', 'streaming', $4)
RETURNING *;

-- name: AppendAgentChannelMessageBody :exec
UPDATE channel_message
SET body = body || $2
WHERE id = $1 AND delivery_status = 'streaming';

-- name: FinalizeAgentChannelMessage :one
-- Status guard: only transitions FROM 'streaming' are allowed. If a retry
-- causes CompleteTask + FailTask to race on the same task, the second writer
-- gets pgx.ErrNoRows instead of overwriting the first's outcome.
--
-- final_body: when non-empty, replaces the body wholesale (used when the
-- daemon ships the agent's final answer in one shot at task completion
-- rather than streaming token-by-token, which would leak intermediate
-- reasoning narration into the visible reply). NULL/empty leaves the
-- existing body alone — that path is used for the failure branch.
UPDATE channel_message
SET delivery_status = sqlc.arg('delivery_status'),
    failure_reason  = sqlc.narg('failure_reason'),
    body            = COALESCE(NULLIF(sqlc.narg('final_body')::text, ''), body),
    edited_at       = CASE WHEN sqlc.arg('delivery_status') = 'complete' THEN edited_at ELSE now() END
WHERE id = sqlc.arg('id') AND delivery_status = 'streaming'
RETURNING *;

-- name: GetStreamingChannelMessageByTaskID :one
-- Used by daemon-progress handlers to retrieve the streaming placeholder row
-- created during StartTask without needing to stash the message_id elsewhere.
SELECT * FROM channel_message
WHERE task_id = $1 AND delivery_status = 'streaming'
LIMIT 1;
