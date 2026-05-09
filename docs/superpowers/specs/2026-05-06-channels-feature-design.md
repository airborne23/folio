# Folio Channels — Design

**Status:** Draft
**Author:** jiangkai
**Date:** 2026-05-06
**Target branch:** `feat/channels`
**Distribution:** Local-only fork (no upstream PR planned)

## 1. Background

Folio today exposes two "talk-to-agent" surfaces: issue comments and 1:1 sandboxed chat. Both are dyadic. There is no group surface where multiple humans and multiple agents share a single conversation, and no way for agents in the same workspace to see and respond to each other.

This spec adds **channels** — multi-member rooms where users and agents are first-class peers, agents can subscribe to a channel and reply autonomously (with safeguards), and threads keep multi-topic discussion readable.

## 2. Goals

- Group conversations with N humans + M agents as members.
- Agents-talking-to-agents within a channel, default-on per channel, off-by-default per agent (override-able).
- Threads on any message (Slack-style side drawer).
- Emoji reactions on any message.
- Real-time updates via the existing WebSocket fan-out path.
- Agent dispatch reuses `agent_task_queue` — no new execution path on the daemon side.
- Multi-turn provider session continuity per `(agent, channel)`, mirroring how 1:1 chat does it per `(agent, conversation)`.

## 3. Non-goals (explicit deferrals)

- **Group DM** — data model already supports it via `channel.kind='group_dm'` (no `name`, fixed members, no public discovery). UI entry point not built in MVP. Add in a follow-up.
- File / image attachments. Channel messages are text + Markdown only.
- Channel-scoped search.
- Unread/notification badges. Existing `inbox_item` patterns can be extended later; MVP shows raw timestamps.
- Channel-level pins, bookmarks, integrations.
- Auto-translating @mentions to "agent permission grants" (channel ≠ issue, no permission boundary to grant).
- Public-channel discovery beyond a flat list.

## 4. High-level architecture

Channels are a new vertical slice that plugs into folio's existing infrastructure without disturbing it.

```
┌─────────────────────────── apps/web (Next.js) / apps/desktop (Electron) ───────────────────────┐
│  /(dashboard)/channels                                                                          │
│  packages/views/channels/   ← shared business UI                                                │
│  packages/core/channels/    ← TanStack Query keys, mutations, ws-updaters                       │
└────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                              │ HTTPS/REST + WS (existing client)
                                              ▼
┌─────────────────────────── server/ (Go, Chi, sqlc, gorilla/websocket) ─────────────────────────┐
│  internal/handler/channel.go             — REST + auth + subscribe-WS broadcast                 │
│  internal/handler/channel_message.go     — REST: create / list / thread fetch                   │
│  internal/handler/channel_reaction.go    — REST: add / remove                                   │
│  internal/agent/channel_dispatcher.go    — decides which agents get a task per new message      │
│  pkg/db/queries/channel.sql              — sqlc queries (regenerated via `make sqlc`)           │
│  migrations/069_channels.up.sql / .down  — new tables only, no edits to existing tables         │
└────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                              │ existing INSERT into agent_task_queue
                                              ▼
                                       daemon (unchanged execution path,
                                       new prompt branch keyed on agent_task_queue.channel_id IS NOT NULL)
```

Hard constraints inherited from `CLAUDE.md`:

- `packages/core/channels/` is platform-agnostic (no `next/*`, no `react-router`).
- `packages/views/channels/` consumes only `core/` and `ui/`.
- WS events invalidate TanStack queries — they never write to Zustand stores directly.
- Workspace-scoped queries key on `wsId`.
- Mutations are optimistic by default, rolled back on failure, invalidated on settle.
- Internal use only per LICENSE; logo/copyright untouched in any frontend changes.

## 5. Data model

All new tables. No edits to existing tables. UUID PKs, TIMESTAMPTZ timestamps, TEXT + CHECK enums to match the existing style.

```sql
-- Channels
CREATE TABLE channel (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT,                                    -- NULL only when kind='group_dm'
    kind TEXT NOT NULL CHECK (kind IN ('public','private','group_dm')),
    topic TEXT,
    -- ON DELETE SET NULL (not CASCADE like chat_session.creator_id): channels
    -- are shared spaces and must outlive their creator's membership lifecycle.
    creator_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
    archived_at TIMESTAMPTZ,
    -- Agent-talk safeguards (per channel; per-agent override via channel_member.subscribe_mode)
    default_subscribe_mode TEXT NOT NULL DEFAULT 'subscribe'
        CHECK (default_subscribe_mode IN ('mention_only','subscribe')),
    agent_cooldown_ms INT NOT NULL DEFAULT 30000,
    max_consecutive_agent_turns INT NOT NULL DEFAULT 5,
    consecutive_agent_turns INT NOT NULL DEFAULT 0,  -- mutable, reset on human message
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

-- Channel membership (humans-as-member or agents)
-- Mirrors the issue assignee polymorphism: (member|agent) + UUID
CREATE TABLE channel_member (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('member','agent')),
    member_id UUID NOT NULL,
    -- Per-agent override of channel default. NULL for member_type='member'.
    subscribe_mode TEXT CHECK (subscribe_mode IN ('mention_only','subscribe')),
    last_replied_at TIMESTAMPTZ,                  -- per-agent cooldown clock
    -- Per-(agent, channel) provider session continuity
    provider_session_id TEXT,
    last_known_good_session_id TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel_id, member_type, member_id)
);
CREATE INDEX idx_channel_member_channel ON channel_member(channel_id);
CREATE INDEX idx_channel_member_lookup
    ON channel_member(member_type, member_id, channel_id);

-- Messages
CREATE TABLE channel_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
    -- Author polymorphism, same shape as issue.creator_*
    author_type TEXT NOT NULL CHECK (author_type IN ('member','agent')),
    author_id UUID NOT NULL,
    body TEXT NOT NULL,                                -- markdown
    parent_message_id UUID REFERENCES channel_message(id) ON DELETE CASCADE,
    -- Mention extraction (filled by handler before insert; used by dispatcher)
    mentions JSONB NOT NULL DEFAULT '[]',              -- [{type:'agent'|'member', id}]
    -- Cached thread roll-up (maintained by handler / dispatcher post-INSERT)
    reply_count INT NOT NULL DEFAULT 0,
    last_reply_at TIMESTAMPTZ,
    reply_participants JSONB NOT NULL DEFAULT '[]',    -- [{type, id}]
    -- Streaming state for agent replies (mirrors the chat 'failure_reason' shape)
    delivery_status TEXT NOT NULL DEFAULT 'complete'
        CHECK (delivery_status IN ('streaming','complete','failed')),
    failure_reason TEXT,                               -- agent_error|connection_error|timeout|...
    task_id UUID,                                      -- backlink to agent_task_queue if agent message
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ
);
CREATE INDEX idx_channel_message_channel_created
    ON channel_message(channel_id, created_at DESC) WHERE parent_message_id IS NULL;
CREATE INDEX idx_channel_message_thread
    ON channel_message(parent_message_id, created_at) WHERE parent_message_id IS NOT NULL;

-- Reactions
CREATE TABLE channel_message_reaction (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES channel_message(id) ON DELETE CASCADE,
    reactor_type TEXT NOT NULL CHECK (reactor_type IN ('member','agent')),
    reactor_id UUID NOT NULL,
    emoji TEXT NOT NULL,                              -- raw unicode (no custom emoji in MVP)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, reactor_type, reactor_id, emoji)
);
-- No standalone (message_id) index — the UNIQUE constraint's auto-created btree
-- on (message_id, reactor_type, reactor_id, emoji) already serves message lookups.
```

**Agent dispatch glue:** Migration 003 added `agent_task_queue.context JSONB` and the existing pattern uses dedicated nullable FK columns to discriminate task source (`issue_id`, `chat_session_id`). We extend that pattern: add `agent_task_queue.channel_id UUID REFERENCES channel(id) ON DELETE SET NULL`, plus a partial index on `(channel_id, created_at DESC) WHERE channel_id IS NOT NULL AND status IN ('queued','dispatched','running')`. The dispatcher sets `channel_id` and stashes `{trigger_message_id, parent_message_id?, provider_session_id}` into the existing `context` JSONB. Daemon-side prompt builder switches on whichever FK is non-null. There is no `task_context` table.

## 6. Backend changes (Go)

### 6.1 New files

```
server/migrations/069_channels.up.sql      (single migration; XX = next free number)
server/migrations/069_channels.down.sql    (drop in reverse dep order)
server/pkg/db/queries/channel.sql          (sqlc queries — see 6.3)
server/internal/handler/channel.go         (CRUD: create / list / get / archive / member CRUD)
server/internal/handler/channel_message.go (create / list / thread fetch / mention parse)
server/internal/handler/channel_reaction.go (add / remove)
server/internal/agent/channel_dispatcher.go (the agent-trigger logic)
```

### 6.2 Routes (Chi, mounted under `/api/workspaces/{slug}/channels`)

```
POST   /channels                                  create channel
GET    /channels                                  list (kind filter, search)
GET    /channels/{id}                             detail
PATCH  /channels/{id}                             rename / topic / archive
PUT    /channels/{id}/members/{memberRef}         add or update (memberRef = "user:<uuid>" | "agent:<uuid>")
DELETE /channels/{id}/members/{memberRef}         remove

POST   /channels/{id}/messages                    send message (parent_message_id optional → thread reply)
GET    /channels/{id}/messages?cursor=&limit=     paged main timeline (parent IS NULL)
GET    /channels/{id}/messages/{msgId}/thread     all replies + parent

POST   /channels/{id}/messages/{msgId}/reactions  body: {emoji}
DELETE /channels/{id}/messages/{msgId}/reactions  body: {emoji} (idempotent)
```

Auth: existing `RequireWorkspaceMember` middleware. Private channel access additionally checks `channel_member` row exists for the calling member.

### 6.3 sqlc queries (sketch)

`server/pkg/db/queries/channel.sql` adds named queries; key ones:

- `CreateChannel`, `ArchiveChannel`, `ListChannelsForMember` (joins `channel_member` so the same query returns public + member-of-private)
- `UpsertChannelMember`, `RemoveChannelMember`, `ListChannelMembers`
- `InsertChannelMessage`, `ListChannelMainMessages` (cursor on `(created_at,id)`), `ListChannelThreadMessages`
- `BumpThreadRollup` — atomic update of parent's `reply_count`, `last_reply_at`, `reply_participants`
- `ListAgentChannelMembersForDispatch` (only `member_type='agent'` rows + cooldown view)
- `ResetConsecutiveAgentTurns`, `IncrementConsecutiveAgentTurns`
- `AddReaction`, `RemoveReaction`, `ListReactionsForMessages`

After editing this file, run `make sqlc` to regenerate Go bindings.

### 6.4 Dispatcher logic (the core mechanism)

`channel_dispatcher.go` exposes `Dispatch(ctx, msg ChannelMessage)`. Called from `channel_message.go` after a successful INSERT, **inside the same DB transaction** so cooldown bookkeeping is atomic.

```
Dispatch(msg):
  1. Load channel + all agent members of that channel (one query).
  2. If author_type = 'member':
        consecutive_agent_turns := 0    (reset; humans always reopen the gate)
     If author_type = 'agent':
        consecutive_agent_turns += 1
        If consecutive_agent_turns >= max_consecutive_agent_turns: STOP (gate closed)
  3. mentioned_agents = mentions where type='agent'
  4. For each agent_member of the channel:
       priority = NORMAL
       if agent_member.id ∈ mentioned_agents:
          priority = HIGH; bypass cooldown; bypass consecutive-turn gate
       else:
          mode = COALESCE(agent_member.subscribe_mode, channel.default_subscribe_mode)
          if mode = 'mention_only': SKIP
          if (now - agent_member.last_replied_at) < channel.agent_cooldown_ms: SKIP
          if author_type='agent' AND agent_member.id = msg.author_id: SKIP   (no self-reply storm)
       Enqueue task in agent_task_queue with:
         channel_id = msg.channel_id     -- new FK column on agent_task_queue
         context = { channel_id, trigger_message_id: msg.id,
                     parent_message_id: msg.parent_message_id,
                     provider_session_id: agent_member.provider_session_id }
         priority
  5. Broadcast WS event 'channel.message.created' to all subscribers.
```

When the daemon completes the task and posts the agent's reply via the existing task-completion path, `channel_message.go`'s post-handler:

- INSERTs the agent's reply row (`author_type='agent'`, `task_id=<task>`, `delivery_status='streaming'` initially, flipping to `'complete'` on final chunk).
- Updates `channel_member.last_replied_at` and `provider_session_id` for that agent in this channel.
- Re-runs `Dispatch` with the new agent message — this is what creates agent-to-agent flow under `subscribe`.

**Streaming:** mirror the chat path. The handler creates a `channel_message` row early with `delivery_status='streaming'` and an empty `body`; daemon streams chunks back via `daemon_ws.go`; each chunk PATCHes `body` and broadcasts `channel.message.patched` (throttled to ~10 Hz server-side). Final chunk flips `delivery_status='complete'`.

**Failure path:** mirrors chat's FailTask. On daemon error, set `delivery_status='failed'` and `failure_reason='agent_error|connection_error|timeout'`. UI renders a destructive bubble. Cooldown / consecutive-turn counters still tick (a failure counts as a turn) so a stuck agent can't infinite-loop.

### 6.5 Threads detail

- `parent_message_id` self-FK; threads are flat (one level). Replying to a reply uses the same parent.
- Thread context for agent dispatch: when `trigger_message_id`'s parent is non-null, agent prompt receives **only that thread's messages** (parent + descendants), not the surrounding main timeline. Rationale: keeps token cost predictable; mirrors human reading model.
- `consecutive_agent_turns` and `agent_cooldown_ms` apply at **channel level**, not thread level — otherwise multiple parallel threads could each bypass the gate.

### 6.6 WS events

Mounted on the existing `daemon_ws.go` / browser WS gateway. New event types in `shared/types`:

- `channel.created`, `channel.updated`, `channel.archived`
- `channel.member.added`, `channel.member.removed`, `channel.member.updated`
- `channel.message.created` (full message payload)
- `channel.message.patched` (id + body delta + delivery_status)
- `channel.message.completed` (id, final delivery_status)
- `channel.thread.rollup` (parent_id, reply_count, last_reply_at, reply_participants)
- `channel.reaction.added`, `channel.reaction.removed`

Each event carries `workspace_id` and `channel_id`. Per folio's hard rule, the frontend only reacts by **invalidating queries** — never by writing to Zustand. The corresponding `core/channels/ws-updaters.ts` maps event → query-key invalidations.

## 7. Frontend changes (TS)

### 7.1 `packages/core/channels/`

```
index.ts          public exports
queries.ts        TanStack queryOptions: list, detail, members, messages, thread
mutations.ts      create channel, send message, edit (NA in MVP), add reaction, archive
store.ts          Zustand: composer drafts (per-channel), open-thread id, scroll-anchor
ws-updaters.ts    map every channel.* event → invalidateQueries
types.ts          Channel, ChannelMember, ChannelMessage, Reaction
```

Mirror the shape of `packages/core/chat/` and `packages/core/inbox/`.

### 7.2 `packages/views/channels/`

```
components/
  channel-sidebar-section.tsx      list under workspace sidebar
  channel-create-dialog.tsx
  channel-view.tsx                 main timeline + composer
  channel-message.tsx              one row; agent vs member styling; streaming spinner
  channel-message-actions.tsx      hover toolbar: react / reply in thread
  thread-drawer.tsx                right-side panel
  reaction-bar.tsx                 pill row + emoji picker
  channel-settings-panel.tsx       members, agent_cooldown_ms, max_consecutive_agent_turns
  channel-member-row.tsx           shows per-agent subscribe_mode dropdown
  no-agent-banner.tsx              reuse from packages/views/chat
```

### 7.3 `apps/web/app/[workspaceSlug]/(dashboard)/channels/`

```
page.tsx                    list view (joined channels first, browse public below)
[channelId]/page.tsx        channel detail; ?thread=<id> opens drawer
```

### 7.4 `apps/desktop/src/renderer/src/...`

Tab-store entry for channels; route registration in `routes.tsx`. Reuses the same `views/channels/` components.

### 7.5 Sidebar integration

Folio's existing sidebar lists workspace nav. Add a "Channels" section above "Inbox", showing joined channels with a "+" affordance. Public channels not yet joined go behind a "Browse" entry.

### 7.6 i18n

Add EN + zh-CN strings to `packages/views/locales/` per `apps/docs/content/docs/developers/conventions.mdx` glossary. New nouns to add to glossary: 频道(channel), 主题(topic), 群组私信(group DM), 串(thread), 表情回应(reaction).

## 8. Build sequence

Each phase is independently shippable and merge-able. Don't start phase N+1 until N's local manual test passes.

### Phase A — Data layer + bare CRUD (no agents, no realtime)
- Migration 0XX up/down.
- sqlc queries; regen Go bindings.
- `channel.go` handler: create / list / get / archive; `channel_member` CRUD restricted to `member_type='member'` (humans).
- `channel_message.go`: create / list (main timeline only); no thread, no streaming, no dispatcher.
- `core/channels/` queries + mutations (no WS yet); `views/channels/` channel-view bare bones.
- Manual test: create channel, add humans, send messages, refresh shows them.

### Phase B — Realtime broadcast + subscription
- WS event types added to `shared/types` and `daemon_ws.go` gateway.
- `ws-updaters.ts` invalidations.
- Verify: two browser tabs as different members see each other's messages without refresh.

### Phase C — Agent membership + dispatcher (mention_only first)
- Allow `member_type='agent'` in `channel_member`.
- Dispatcher with `mention_only` only (no `subscribe` mode yet).
- `agent_task_queue.channel_id` discriminates channel-context tasks; daemon prompt template extended to render channel history.
- `delivery_status='streaming'` + `channel.message.patched` events working.
- Manual test: @mention an agent, agent replies inline.

### Phase D — Subscribe mode + cooldown + consecutive-turn gate
- Add `subscribe` to `subscribe_mode` enum default; channel-level `agent_cooldown_ms`, `max_consecutive_agent_turns`, `consecutive_agent_turns`.
- Dispatcher implements full ruleset including no-self-reply.
- `channel-settings-panel.tsx` exposes cooldown / max-turns sliders and per-agent override.
- Manual test: 2 agents in `subscribe` mode hold a back-and-forth; gate locks after N turns; human message reopens gate.

### Phase E — Threads
- `parent_message_id` enabled in API + UI; `thread-drawer.tsx`; `BumpThreadRollup` query.
- Dispatcher restricts agent context to thread for thread replies.
- Manual test: open thread on an agent's reply, ask follow-up, agent answers within thread; main timeline unaffected.

### Phase F — Reactions
- `channel_message_reaction` CRUD + UI pill bar + emoji picker.
- WS: `channel.reaction.added/removed`.
- No agent UX impact (reactions don't trigger dispatch in MVP — explicit non-goal).

### Phase G — Polish & i18n
- Glossary entries committed.
- Empty states, error states, loading skeletons.
- Failure-bubble UI for `delivery_status='failed'`.
- One Playwright e2e: create channel → @ agent → assert reply within 30s.

## 9. Failure modes & edge cases

**Agent goes offline mid-stream:** `channel.message.patched` heartbeats stop. After a 60s server-side timeout, mark `delivery_status='failed'`, `failure_reason='connection_error'`. UI renders the partial body greyed-out plus a retry button; retry creates a new task with the same `provider_session_id` to resume.

**Daemon dies between two streamed chunks:** server-side timeout above catches it. The agent's `last_replied_at` is updated on first chunk receipt, so the cooldown clock starts at first response, not at task enqueue — prevents a dead agent from blocking dispatch indefinitely.

**Self-reply storm:** dispatcher rule "if author_type='agent' AND agent_member.id = msg.author_id: SKIP" prevents an agent from triggering itself. Cross-agent ping-pong is bounded by `max_consecutive_agent_turns`.

**Two agents both `@mention`-bypass cooldown simultaneously:** both get HIGH-priority tasks; both reply within milliseconds of each other. This is acceptable — the @mention is an explicit human override of safeguards.

**Race: human and agent reply within the same millisecond:** UNIQUE index doesn't apply (different rows). Sort by `(created_at, id)` for stable ordering. UI renders accordingly.

**Member removed from private channel mid-conversation:** server filters their `channel.message.created` WS subscription on next ack; existing client-side TanStack cache for that channel is purged on a `channel.member.removed` event for self.

**Workspace deleted:** `ON DELETE CASCADE` from `workspace.id` flows through `channel.workspace_id` and propagates downward. No orphans.

**Agent's `provider_session_id` invalidated by the provider:** dispatcher reads `provider_session_id`; daemon attempts resume; on `session_expired` error, daemon clears `provider_session_id` and falls back to `last_known_good_session_id`; on second failure, both fields cleared and the next reply starts a fresh session (reading recent channel history into the prompt as bootstrap).

**Migration rollback:** `069_channels.down.sql` drops in reverse dep order: drop the partial index on `agent_task_queue.channel_id`, drop the `channel_id` column, then drop reactions → messages → members → channel. Down-migration loses all channel data — acceptable for local self-use; documented in the migration's leading comment.

## 10. Out-of-scope items the design has space for

- **Group DM** UI: data already supports `kind='group_dm'`. Add a "New direct message" entry that creates a `kind='group_dm'` channel without a name and pins it to a separate sidebar section.
- **Custom emoji**: replace `emoji TEXT` with `emoji_id UUID` referencing a workspace `custom_emoji` table; backwards-compatible if we keep `emoji` as a denormalized cache.
- **Pins / bookmarks**: per-channel `channel_pin` table referencing `channel_message`.
- **Notifications**: extend existing `inbox_item` shape with `source_kind='channel_mention'`.
- **File attachments**: existing `file` handler already exists in folio; extend `channel_message` with a `file_ids JSONB` column.
- **Search**: pgvector or trigram index on `channel_message.body`; out of MVP because of the index/migration cost.

## 11. Open questions

None blocking. The spec is intentionally specific; downstream-of-this decisions (emoji picker library, drawer animation easing, Markdown renderer choice) are taken by the implementing PR per folio's existing conventions.
