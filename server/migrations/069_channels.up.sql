-- 069_channels.up.sql

CREATE TABLE channel (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('public','private','group_dm')),
    topic TEXT,
    -- ON DELETE SET NULL (not CASCADE like chat_session.creator_id): channels are
    -- shared spaces and must outlive their creator's membership lifecycle.
    creator_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
    archived_at TIMESTAMPTZ,
    default_subscribe_mode TEXT NOT NULL DEFAULT 'subscribe'
        CHECK (default_subscribe_mode IN ('mention_only','subscribe')),
    agent_cooldown_ms INT NOT NULL DEFAULT 30000,
    max_consecutive_agent_turns INT NOT NULL DEFAULT 5,
    consecutive_agent_turns INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT channel_name_required_unless_group_dm CHECK (
        (kind = 'group_dm' AND name IS NULL)
        OR (kind <> 'group_dm' AND name IS NOT NULL AND length(trim(name)) > 0)
    )
);
CREATE UNIQUE INDEX idx_channel_workspace_name_unique
    ON channel(workspace_id, lower(name))
    WHERE name IS NOT NULL AND length(trim(name)) > 0 AND archived_at IS NULL;
CREATE INDEX idx_channel_workspace_kind ON channel(workspace_id, kind);

CREATE TABLE channel_member (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('member','agent')),
    member_id UUID NOT NULL,
    subscribe_mode TEXT CHECK (subscribe_mode IN ('mention_only','subscribe')),
    last_replied_at TIMESTAMPTZ,
    provider_session_id TEXT,
    last_known_good_session_id TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel_id, member_type, member_id)
);
CREATE INDEX idx_channel_member_channel ON channel_member(channel_id);
CREATE INDEX idx_channel_member_lookup ON channel_member(member_type, member_id, channel_id);

CREATE TABLE channel_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('member','agent')),
    author_id UUID NOT NULL,
    body TEXT NOT NULL,
    parent_message_id UUID REFERENCES channel_message(id) ON DELETE CASCADE,
    mentions JSONB NOT NULL DEFAULT '[]',
    reply_count INT NOT NULL DEFAULT 0,
    last_reply_at TIMESTAMPTZ,
    reply_participants JSONB NOT NULL DEFAULT '[]',
    delivery_status TEXT NOT NULL DEFAULT 'complete'
        CHECK (delivery_status IN ('streaming','complete','failed')),
    failure_reason TEXT,
    task_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ
);
CREATE INDEX idx_channel_message_channel_created
    ON channel_message(channel_id, created_at DESC) WHERE parent_message_id IS NULL;
CREATE INDEX idx_channel_message_thread
    ON channel_message(parent_message_id, created_at) WHERE parent_message_id IS NOT NULL;

CREATE TABLE channel_message_reaction (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES channel_message(id) ON DELETE CASCADE,
    reactor_type TEXT NOT NULL CHECK (reactor_type IN ('member','agent')),
    reactor_id UUID NOT NULL,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, reactor_type, reactor_id, emoji)
);
-- No separate index on (message_id) — the UNIQUE above auto-creates a btree
-- on (message_id, reactor_type, reactor_id, emoji) whose leading column already
-- serves single-message lookups.

-- Discriminator for channel-context tasks (mirrors issue_id / chat_session_id pattern).
ALTER TABLE agent_task_queue
    ADD COLUMN channel_id UUID REFERENCES channel(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_task_queue_channel_pending
    ON agent_task_queue(channel_id, created_at DESC)
    WHERE channel_id IS NOT NULL AND status IN ('queued','dispatched','running');

-- Streaming agent replies are looked up by task_id at every progress chunk
-- (~10 Hz hot path). UNIQUE because one task produces at most one streaming
-- placeholder; partial index because the column is nullable.
CREATE UNIQUE INDEX idx_channel_message_task_id
    ON channel_message(task_id) WHERE task_id IS NOT NULL;
