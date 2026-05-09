# Folio Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add group channels with humans + agents as members, agent-to-agent conversation under cooldown safeguards, threads, and reactions to folio.

**Architecture:** Four new tables (`channel`, `channel_member`, `channel_message`, `channel_message_reaction`) plus a nullable `channel_id` FK column on `agent_task_queue` (mirrors the existing `issue_id` / `chat_session_id` discriminator pattern). Reuses `agent_task_queue` for agent dispatch and the existing gorilla/websocket fan-out via `events.Bus`. Frontend follows the existing slice pattern (`packages/core/chat/`, `packages/views/chat/`).

**Tech Stack:** Go 1.26 + Chi + sqlc + pgx + gorilla/websocket; Next.js App Router + TanStack Query + Zustand + shadcn/Base UI; Vitest + Playwright; pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-05-06-channels-feature-design.md`

---

## File map

**Backend (Go):**
- Create `server/migrations/069_channels.up.sql`
- Create `server/migrations/069_channels.down.sql`
- Create `server/pkg/db/queries/channel.sql`
- Create `server/internal/handler/channel.go` + `channel_test.go`
- Create `server/internal/handler/channel_message.go` + `channel_message_test.go`
- Create `server/internal/handler/channel_reaction.go` + `channel_reaction_test.go`
- Create `server/internal/agent/channel_dispatcher.go` + `channel_dispatcher_test.go`
- Create `server/internal/events/channel_events.go` (typed event constructors)
- Modify `server/internal/handler/handler.go` (register routes; ~25 LOC)
- Modify `server/cmd/folio/main.go` or wherever the dispatcher is wired

**Frontend (TS):**
- Create `packages/core/types/channel.ts`
- Create `packages/core/channels/{index.ts, queries.ts, mutations.ts, store.ts, ws-updaters.ts}` (+ tests)
- Create `packages/core/api/channels.ts` (API client methods)
- Create `packages/views/channels/components/*.tsx` (ten components)
- Create `apps/web/app/[workspaceSlug]/(dashboard)/channels/page.tsx`
- Create `apps/web/app/[workspaceSlug]/(dashboard)/channels/[channelId]/page.tsx`
- Modify `packages/views/sidebar/...` (sidebar entry)
- Modify `apps/desktop/src/renderer/src/routes.tsx`

**i18n:**
- Modify `packages/views/locales/en.json` and `zh-CN.json`
- Modify `apps/docs/content/docs/developers/conventions.mdx` glossary

**E2E:**
- Create `e2e/tests/channels-basic.spec.ts`
- Create `e2e/tests/channels-agent-mention.spec.ts`
- Create `e2e/tests/channels-thread.spec.ts`

---

## Task numbering convention

Each task ID is `<Phase>.<Task>`. Phases A–G match §8 of the spec. Steps inside a task are atomic (2–5 min) and use `- [ ]`. Each task ends with a commit.

---

## ⚠ Conventions discovered during Phase A — supersede the original task code blocks

The plan's original code blocks for Phase A–G were drafted before reading folio's actual handler/test/i18n conventions. Phase A surfaced and corrected them. **Implementers of Phase B onward MUST use the conventions below when the original task block conflicts.**

### Server-side (Go)

- **Routes mount in `server/cmd/server/router.go`**, not `server/internal/handler/handler.go`. Path is `/api/channels` (no `/workspaces/{slug}/` prefix). Workspace context comes from the `X-Workspace-ID` header, accessed via `h.resolveWorkspaceID(r) string` (NOT bare `ctxWorkspaceID` — that returns `""` in tests).
- **Member lookup:** `h.workspaceMember(w, r, workspaceID) (db.Member, bool)`. Reads from middleware-cached context in production; falls back to a DB lookup in tests. Auto-handles auth via `requireUserID` in the fallback path. Do NOT call `requireUserID` + `parseUUID(userID)` + `GetMemberByUserAndWorkspace` directly — the helper exists for this.
- **Channel-belongs-to-workspace check:** `h.loadWorkspaceChannel(w, r, channelUUID, workspaceUUID) (db.Channel, bool)` already exists in `channel.go`. Use it for any GetChannelByID + 404 mapping.
- **Channel visibility check (private/group_dm):** mirror the `GetChannel` pattern — call `h.Queries.IsChannelMember(ctx, IsChannelMemberParams{ChannelID, MemberType:"member", MemberID:caller.ID})` and return 404 if not a member. Already used by `GetChannel`, `ListChannelMembers`, `SendChannelMessage`, `ListChannelMessages`.
- **Atomic multi-write handlers:** wrap with `tx, err := h.TxStarter.Begin(ctx)` + `defer tx.Rollback(ctx)` + `qtx := h.Queries.WithTx(tx)` + `tx.Commit(ctx)`. See `CreateChannel` for the canonical example.
- **Bus publish convention:** `h.Bus.Publish(events.Channel<Verb>(workspaceID, ...))` AFTER the DB write succeeds (and after `tx.Commit` if inside a tx). Event Kind constants are colon-separated (`channel:created`, `channel:member:added`, `channel:message:created`, etc.) — see `server/internal/events/channel_events.go`. NEVER use dot-separated.
- **Error mapping:** `errors.Is(err, pgx.ErrNoRows) → 404`; `isUniqueViolation(err) → 409`; otherwise → 500.
- **UUID parsing:** raw URL/body params → `parseUUIDOrBadRequest(w, s, fieldName)`; trusted UUIDs (sqlc-returned, fixtures) → `parseUUID(s)` (panics on bad).
- **Response wire format:** typed `ChannelResponse` / `ChannelMemberResponse` / `ChannelMessageResponse` structs already exist in `channel.go`. Use the corresponding `*ToResponse` converter and `writeJSON(w, status, payload)` to emit. NEVER `json.NewEncoder(w).Encode(dbRow)` directly.
- **sqlc workflow:** edit `server/pkg/db/queries/channel.sql`, run `make sqlc`, commit both the SQL and the regenerated `server/pkg/db/generated/`.

### Server-side test fixtures

- **Globals:** `testHandler *Handler`, `testUserID string`, `testWorkspaceID string` (UUID as string), `testPool *pgxpool.Pool`.
- **Test request helper:** `newRequest(method, path string, body any) *http.Request` — encodes `body` as JSON, sets `X-User-ID` and `X-Workspace-ID` headers automatically. Body is `any` (e.g. `map[string]any{"body":"hi"}`); NOT a `strings.Reader`.
- **Path-param plumbing:** `withURLParam(req, "channelID", id)` for one chi path param; `withURLParams(req, "channelID", id, "memberRef", ref)` for two (BOTH set in the SAME chi route context — chained `withURLParam` calls drop earlier params silently).
- **Handler invocation:** `testHandler.<HandlerName>(rr, req)` directly (NOT `testHandler.ServeHTTP(rr, req)` — handlers aren't mounted on `*Handler`, only on the chi router).
- **Skip preamble:** `if testHandler == nil { t.Skip("database not available") }`.
- **Channel cleanup helper:** `cleanupChannel(t, id)` — registers `t.Cleanup` that deletes the channel row by id. Tests that successfully create a channel via the API MUST call this.
- **Seed helpers:** `mustCreateChannel(t, name, kind)` returns the response map (with `"id"`); `mustSeedSecondMember(t)` creates a fresh user+member in `testWorkspaceID` and returns the member id.
- **Bus subscription test pattern:** because the bus dispatches synchronously, after `Publish` returns the event is already in your buffered channel. Use `select { case e := <-ch: ...; default: t.Fatal("not delivered synchronously") }` — NEVER `time.After` (creates a non-deterministic 2-second wait on the failure path).

### Frontend imports / paths

- `cn` from `@folio/ui/lib/utils`
- UI components from `@folio/ui/components/ui/<name>` (e.g. `@folio/ui/components/ui/button`)
- `useNavigation` from `../../navigation` (relative within `packages/views/`)
- `useWorkspaceId` from `@folio/core/hooks`
- `useWorkspacePaths` from `@folio/core/paths` — and ALL channel navigation should go through `useWorkspacePaths().channelDetail(id)` / `useWorkspacePaths().channels()`. Bare `/channels/${id}` paths break web (they need the workspace slug prefix).
- `useT` from `@folio/views/i18n` for any user-visible string (G.1 will create the `channels` namespace; until then, hardcoded English is acceptable but mark with a `// G.1: i18n` comment so they're easy to find).
- Toasts from `sonner` — `import { toast } from "sonner"` then `toast.error(...)` / `toast.success(...)`.

### Frontend mutation pattern

- Mutations call `useWorkspaceId()` INTERNALLY — do NOT take `wsId` as a hook parameter (CLAUDE.md's "hook accepts wsId" rule is for sidebar-style hooks that render outside `WorkspaceIdProvider`; mutations are always inside it).
- Optimistic updates: `onMutate` cancels queries → snapshots prev → writes optimistic to cache; `onError` restores prev; `onSettled` invalidates. See `useSendChannelMessage` for the canonical shape.
- `mutateAsync` callers MUST wrap in `try/catch` and surface errors via `toast.error(...)`. Don't let promise rejections silently strand the UI in a "submitting" state.

### Frontend query pattern

- Use `useQuery` (NOT `useSuspenseQuery`) in `packages/views/channels/`. Rationale: most callers don't have a Suspense boundary, and the rest of `packages/views/` uses `useQuery` with `isLoading` guards (`{ data: items = [], isLoading } = useQuery(...)`).
- `staleTime: Infinity` is the folio default — WS events drive invalidation.

### Sidebar / app-shell wiring

- `<ChannelsListPage />` lives in `packages/views/channels/components/channels-list-page.tsx` (shared between web and desktop). The web/desktop wrappers are one-liners that just render it. Do NOT create per-app duplicates.
- Sidebar nav entry already registered in `packages/views/layout/app-sidebar.tsx`; locale strings under `nav.channels` in `packages/views/locales/en/layout.json` and `zh-Hans/layout.json`.

### E2E (Playwright)

- Test path: `e2e/channels-*.spec.ts` (top-level, not `e2e/tests/`).
- Use `loginAsDefault(page)` + `createTestApi()` + `api.cleanup()` per `e2e/channels-basic.spec.ts`.
- For UI-created channels: extract id from URL via `await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/)` then `api.trackChannel(channelId)` so cleanup wipes the row. Without this, every run leaks a channel.
- Onboarding dialog (first-run): dismiss with `page.getByRole("button", { name: /start blank workspace/i })` inside a try/catch.

### Specific stale references in the original task code blocks

When you encounter these in a Phase C-G task, translate as follows:

| Original task code | Replace with |
|---|---|
| `newAuthedRequest(t, http.MethodX, "/api/workspaces/"+testWorkspace.Slug+"/channels...", body)` | `newRequest(http.MethodX, "/api/channels...", bodyAsAny)` |
| `testWorkspace.Slug` (anywhere) | drop — URLs no longer include slug |
| `h.Queries.GetMemberIDForUser(...)` | `member, ok := h.workspaceMember(w, r, workspaceID); if !ok { return }` then use `member.ID` |
| `ctxWorkspaceID(r.Context())` direct | `h.resolveWorkspaceID(r)` |
| `KindChannel*` dot-separated values (`"channel.created"`) | colon-separated (`"channel:created"`) |
| Routes added in `server/internal/handler/handler.go` | Routes in `server/cmd/server/router.go` |
| `useSuspenseQuery(...)` in views/channels/ | `useQuery(...)` with `isLoading` guard |
| `useWorkspacePaths()` not used for `/channels/:id` navigation | always use `nav.push(p.channelDetail(id))`, never bare strings |

---

## Phase A — Data layer + bare CRUD (no agents, no realtime)

### Task A.1 — Migration 069: create tables

**Files:**
- Create: `server/migrations/069_channels.up.sql`
- Create: `server/migrations/069_channels.down.sql`

- [ ] **Step 1: Write `069_channels.up.sql`**

```sql
-- 069_channels.up.sql

CREATE TABLE channel (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('public','private','group_dm')),
    topic TEXT,
    -- ON DELETE SET NULL (not CASCADE like chat_session.creator_id): channels
    -- are shared spaces and must outlive their creator's membership lifecycle.
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
-- No standalone (message_id) index — the UNIQUE constraint's auto-created btree
-- on (message_id, reactor_type, reactor_id, emoji) already serves message lookups.

-- Discriminator for channel-context tasks (mirrors issue_id / chat_session_id)
ALTER TABLE agent_task_queue
    ADD COLUMN channel_id UUID REFERENCES channel(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_task_queue_channel_pending
    ON agent_task_queue(channel_id, created_at DESC)
    WHERE channel_id IS NOT NULL AND status IN ('queued','dispatched','running');
```

- [ ] **Step 2: Write `069_channels.down.sql`**

```sql
-- 069_channels.down.sql

-- Drop in reverse FK / dependency order.
DROP INDEX IF EXISTS idx_agent_task_queue_channel_pending;
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS channel_id;

DROP TABLE IF EXISTS channel_message_reaction;
DROP TABLE IF EXISTS channel_message;
DROP TABLE IF EXISTS channel_member;
DROP TABLE IF EXISTS channel;
```

- [ ] **Step 3: Apply and round-trip migration**

Run:
```bash
make migrate-up
make migrate-down  # ensure reversibility
make migrate-up    # leave applied
```
Expected: all three succeed without errors.

- [ ] **Step 4: Verify schema**

Run:
```bash
psql -d folio_dev -c "\d channel" -c "\d channel_member" -c "\d channel_message" -c "\d channel_message_reaction"
```
Expected: each table prints with the columns and constraints from Step 1.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/069_channels.up.sql server/migrations/069_channels.down.sql
git commit -m "feat(db): channels migration 069 — channel/member/message/reaction tables"
```

---

### Task A.2 — sqlc queries for channel CRUD

**Files:**
- Create: `server/pkg/db/queries/channel.sql`

- [ ] **Step 1: Add channel CRUD queries**

```sql
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
-- the channel_name_required_unless_group_dm CHECK will otherwise raise 23514.
-- `topic` uses COALESCE; clearing the topic via PATCH is not supported.
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
-- pgx.ErrNoRows on not-found / wrong-workspace / already-archived → 404 in handler.
UPDATE channel SET archived_at = now(), updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
RETURNING *;

-- name: ResetConsecutiveAgentTurns :exec
UPDATE channel SET consecutive_agent_turns = 0
WHERE id = $1 AND workspace_id = $2;

-- name: IncrementConsecutiveAgentTurns :one
UPDATE channel SET consecutive_agent_turns = consecutive_agent_turns + 1
WHERE id = $1 AND workspace_id = $2
RETURNING consecutive_agent_turns, max_consecutive_agent_turns;
```

- [ ] **Step 2: Regenerate sqlc bindings**

Run:
```bash
make sqlc
```
Expected: `server/pkg/db/generated/channel.sql.go` (and similar) appear/update with no errors.

- [ ] **Step 3: Compile-check**

Run:
```bash
cd server && go build ./...
```
Expected: builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/
git commit -m "feat(db): sqlc queries for channel CRUD"
```

---

### Task A.3 — Channel handler: Create

**Files:**
- Create: `server/internal/handler/channel.go`
- Create: `server/internal/handler/channel_test.go`
- Modify: `server/internal/handler/handler.go` (route registration)

- [ ] **Step 1: Write the failing test**

Add to `server/internal/handler/channel_test.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateChannel_Public(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	_ = ctx

	body := strings.NewReader(`{"name":"general","kind":"public","topic":"Random chat"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["name"] != "general" {
		t.Errorf("name=%v", got["name"])
	}
	if got["kind"] != "public" {
		t.Errorf("kind=%v", got["kind"])
	}
	if got["default_subscribe_mode"] != "subscribe" {
		t.Errorf("default_subscribe_mode=%v", got["default_subscribe_mode"])
	}
}

func TestCreateChannel_GroupDMRequiresNoName(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := strings.NewReader(`{"kind":"group_dm"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_PublicRejectsNoName(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := strings.NewReader(`{"kind":"public"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}
```

> Note: `newAuthedRequest` and `testWorkspace` follow the existing helpers in `handler_test.go`. If your local fixture names differ, adapt them — the assertions are the source of truth.

- [ ] **Step 2: Run tests; verify failure**

Run:
```bash
cd server && go test ./internal/handler/ -run TestCreateChannel -v
```
Expected: FAIL with "route not found" or compile error referencing the missing handler.

- [ ] **Step 3: Implement `channel.go` Create**

Create `server/internal/handler/channel.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/folio-ai/folio/server/pkg/db/generated"
)

type CreateChannelRequest struct {
	Name                     *string `json:"name"`
	Kind                     string  `json:"kind"`
	Topic                    *string `json:"topic"`
	DefaultSubscribeMode     *string `json:"default_subscribe_mode"`
	AgentCooldownMs          *int32  `json:"agent_cooldown_ms"`
	MaxConsecutiveAgentTurns *int32  `json:"max_consecutive_agent_turns"`
}

func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	var req CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Kind {
	case "public", "private":
		if req.Name == nil || *req.Name == "" {
			writeError(w, http.StatusBadRequest, "name is required for public/private channels")
			return
		}
	case "group_dm":
		if req.Name != nil && *req.Name != "" {
			writeError(w, http.StatusBadRequest, "name must be empty for group_dm channels")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "kind must be public/private/group_dm")
		return
	}

	memberID, err := h.Queries.GetMemberIDForUser(r.Context(), db.GetMemberIDForUserParams{
		WorkspaceID: workspaceUUID, UserID: userID,
	})
	if err != nil {
		writeError(w, http.StatusForbidden, "not a workspace member")
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

	var name pgtype.Text
	if req.Name != nil {
		name = pgtype.Text{String: *req.Name, Valid: true}
	}
	var topic pgtype.Text
	if req.Topic != nil {
		topic = pgtype.Text{String: *req.Topic, Valid: true}
	}

	channel, err := h.Queries.CreateChannel(r.Context(), db.CreateChannelParams{
		WorkspaceID:              workspaceUUID,
		Name:                     name,
		Kind:                     req.Kind,
		Topic:                    topic,
		CreatorMemberID:          memberID,
		DefaultSubscribeMode:     defaultMode,
		AgentCooldownMs:          cooldown,
		MaxConsecutiveAgentTurns: maxTurns,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(channel)
}
```

> If `GetMemberIDForUser` doesn't exist as a query yet, add it to `member.sql` (it's a one-liner: `SELECT id FROM member WHERE workspace_id=$1 AND user_id=$2`). Run `make sqlc` again after adding.

- [ ] **Step 4: Register the route**

Modify `server/internal/handler/handler.go` — find the place where `/api/workspaces/{slug}/...` routes are mounted (look for `r.Route("/{workspaceSlug}"`), add inside that subrouter:

```go
r.Route("/channels", func(r chi.Router) {
    r.Post("/", h.CreateChannel)
    // (more added in subsequent tasks)
})
```

- [ ] **Step 5: Run tests; verify pass**

Run:
```bash
cd server && go test ./internal/handler/ -run TestCreateChannel -v
```
Expected: PASS for all three subtests.

- [ ] **Step 6: Commit**

```bash
git add server/internal/handler/channel.go server/internal/handler/channel_test.go server/internal/handler/handler.go server/pkg/db/queries/member.sql server/pkg/db/generated/
git commit -m "feat(server): channel.Create handler + tests"
```

---

### Task A.4 — Channel handler: List + Get + Patch + Archive

**Files:**
- Modify: `server/internal/handler/channel.go`
- Modify: `server/internal/handler/channel_test.go`
- Modify: `server/internal/handler/handler.go` (mount routes)

- [ ] **Step 1: Write failing tests**

Append to `channel_test.go`:

```go
func TestListChannels_PublicVisibleToAll(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	mustCreateChannel(t, "general", "public")
	mustCreateChannel(t, "private-room", "private") // not joined

	req := newAuthedRequest(t, http.MethodGet,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", nil)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	var got []map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	names := map[string]bool{}
	for _, c := range got {
		if n, ok := c["name"].(string); ok {
			names[n] = true
		}
	}
	if !names["general"] {
		t.Error("general missing from list")
	}
	if names["private-room"] {
		t.Error("private-room must NOT be visible to non-member")
	}
}

func TestPatchChannel_RenameAndTopic(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "to-rename", "public")
	body := strings.NewReader(`{"name":"renamed","topic":"now with a topic"}`)
	req := newAuthedRequest(t, http.MethodPatch,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID, body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestArchiveChannel(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "archive-me", "public")
	req := newAuthedRequest(t, http.MethodDelete,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID, nil)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d", rr.Code)
	}
	// Ensure it's no longer in the list.
	listReq := newAuthedRequest(t, http.MethodGet,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", nil)
	listRR := httptest.NewRecorder()
	testHandler.ServeHTTP(listRR, listReq)
	if strings.Contains(listRR.Body.String(), "archive-me") {
		t.Error("archived channel still in list")
	}
}
```

Add a helper at the bottom of `channel_test.go`:

```go
type chanResp struct {
	ID string `json:"id"`
}

func mustCreateChannel(t *testing.T, name, kind string) chanResp {
	t.Helper()
	body := strings.NewReader(`{"name":"` + name + `","kind":"` + kind + `"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed channel %s failed: %s", name, rr.Body.String())
	}
	var c chanResp
	_ = json.NewDecoder(rr.Body).Decode(&c)
	return c
}
```

- [ ] **Step 2: Run; verify failure**

```bash
cd server && go test ./internal/handler/ -run "TestListChannels|TestPatchChannel|TestArchiveChannel" -v
```
Expected: FAIL (routes not registered).

- [ ] **Step 3: Implement List/Get/Patch/Archive in `channel.go`**

```go
func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	memberID, err := h.Queries.GetMemberIDForUser(r.Context(), db.GetMemberIDForUserParams{
		WorkspaceID: workspaceUUID, UserID: userID,
	})
	if err != nil {
		writeError(w, http.StatusForbidden, "not a workspace member")
		return
	}
	rows, err := h.Queries.ListChannelsForMember(r.Context(), db.ListChannelsForMemberParams{
		WorkspaceID: workspaceUUID, MemberID: memberID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	if rows == nil {
		rows = []db.Channel{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rows)
}

func (h *Handler) GetChannel(w http.ResponseWriter, r *http.Request) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id")
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	c, err := h.Queries.GetChannelByID(r.Context(), db.GetChannelByIDParams{
		ID: channelUUID, WorkspaceID: workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	_ = json.NewEncoder(w).Encode(c)
}

type PatchChannelRequest struct {
	Name                     *string `json:"name"`
	Topic                    *string `json:"topic"`
	DefaultSubscribeMode     *string `json:"default_subscribe_mode"`
	AgentCooldownMs          *int32  `json:"agent_cooldown_ms"`
	MaxConsecutiveAgentTurns *int32  `json:"max_consecutive_agent_turns"`
}

func (h *Handler) PatchChannel(w http.ResponseWriter, r *http.Request) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id")
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	var req PatchChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	params := db.UpdateChannelParams{ID: channelUUID, WorkspaceID: workspaceUUID}
	if req.Name != nil {
		params.Name = pgtype.Text{String: *req.Name, Valid: true}
	}
	if req.Topic != nil {
		params.Topic = pgtype.Text{String: *req.Topic, Valid: true}
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
	c, err := h.Queries.UpdateChannel(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	_ = json.NewEncoder(w).Encode(c)
}

func (h *Handler) ArchiveChannel(w http.ResponseWriter, r *http.Request) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id")
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	_, err := h.Queries.ArchiveChannel(r.Context(), db.ArchiveChannelParams{
		ID: channelUUID, WorkspaceID: workspaceUUID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "channel not found or already archived")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "archive failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

Add `"github.com/go-chi/chi/v5"` to imports.

- [ ] **Step 4: Mount routes**

In `handler.go` channels subrouter:

```go
r.Route("/channels", func(r chi.Router) {
    r.Post("/", h.CreateChannel)
    r.Get("/", h.ListChannels)
    r.Get("/{channelID}", h.GetChannel)
    r.Patch("/{channelID}", h.PatchChannel)
    r.Delete("/{channelID}", h.ArchiveChannel)
})
```

- [ ] **Step 5: Run tests; verify pass**

```bash
cd server && go test ./internal/handler/ -run "TestListChannels|TestPatchChannel|TestArchiveChannel|TestCreateChannel" -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/handler/channel.go server/internal/handler/channel_test.go server/internal/handler/handler.go
git commit -m "feat(server): channel List/Get/Patch/Archive"
```

---

### Task A.5 — Channel members CRUD (humans only)

**Files:**
- Modify: `server/pkg/db/queries/channel.sql`
- Modify: `server/internal/handler/channel.go`
- Modify: `server/internal/handler/channel_test.go`
- Modify: `server/internal/handler/handler.go` (routes)

- [ ] **Step 1: Add member queries**

Append to `channel.sql`:

```sql
-- name: UpsertChannelMember :one
INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode)
VALUES ($1, $2, $3, $4)
ON CONFLICT (channel_id, member_type, member_id)
DO UPDATE SET subscribe_mode = EXCLUDED.subscribe_mode
RETURNING *;

-- name: RemoveChannelMember :exec
DELETE FROM channel_member
WHERE channel_id = $1 AND member_type = $2 AND member_id = $3;

-- name: ListChannelMembers :many
SELECT * FROM channel_member WHERE channel_id = $1 ORDER BY joined_at ASC;

-- name: IsChannelMember :one
SELECT EXISTS(
  SELECT 1 FROM channel_member
  WHERE channel_id = $1 AND member_type = 'member' AND member_id = $2
) AS is_member;
```

Run `make sqlc`.

- [ ] **Step 2: Write failing test**

```go
func TestAddRemoveChannelMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "members-test", "private")

	// Add member (the seeded second user — see handler_test.go fixtures).
	body := strings.NewReader(`{}`)
	req := newAuthedRequest(t, http.MethodPut,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/members/member:"+testSecondMemberID, body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}

	// List
	listReq := newAuthedRequest(t, http.MethodGet,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/members", nil)
	listRR := httptest.NewRecorder()
	testHandler.ServeHTTP(listRR, listReq)
	var members []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&members)
	if len(members) != 1 {
		t.Fatalf("want 1 member, got %d", len(members))
	}

	// Remove
	delReq := newAuthedRequest(t, http.MethodDelete,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/members/member:"+testSecondMemberID, nil)
	delRR := httptest.NewRecorder()
	testHandler.ServeHTTP(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("remove: %d", delRR.Code)
	}
}
```

> If `testSecondMemberID` doesn't exist in the test fixtures, add a second member to `handler_test.go` setup. Pattern: `testSecondUser := createTestUser(t, "second@x.com"); testSecondMember := addUserToWorkspace(t, testSecondUser.ID, testWorkspace.ID, "member")`.

- [ ] **Step 3: Run; verify failure**

```bash
cd server && go test ./internal/handler/ -run TestAddRemoveChannelMember -v
```
Expected: FAIL.

- [ ] **Step 4: Implement member handlers**

Append to `channel.go`:

```go
import "strings"

// memberRef is "member:<uuid>" or "agent:<uuid>".
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

func (h *Handler) PutChannelMember(w http.ResponseWriter, r *http.Request) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id")
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	memberRef := chi.URLParam(r, "memberRef")
	kind, idStr, ok := parseMemberRef(memberRef)
	if !ok {
		writeError(w, http.StatusBadRequest, "memberRef must be member:<uuid> or agent:<uuid>")
		return
	}
	memberID, ok := parseUUIDOrBadRequest(w, idStr, "memberRef id")
	if !ok {
		return
	}
	// Phase A: agents not yet allowed; reject early.
	if kind == "agent" {
		writeError(w, http.StatusBadRequest, "agent members not yet supported")
		return
	}
	// Sanity-check channel belongs to workspace.
	if _, err := h.Queries.GetChannelByID(r.Context(), db.GetChannelByIDParams{
		ID: channelUUID, WorkspaceID: workspaceUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}

	var req PutChannelMemberRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // optional body

	var subMode pgtype.Text
	if req.SubscribeMode != nil {
		subMode = pgtype.Text{String: *req.SubscribeMode, Valid: true}
	}
	row, err := h.Queries.UpsertChannelMember(r.Context(), db.UpsertChannelMemberParams{
		ChannelID: channelUUID, MemberType: kind, MemberID: memberID, SubscribeMode: subMode,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "upsert failed")
		return
	}
	_ = json.NewEncoder(w).Encode(row)
}

func (h *Handler) DeleteChannelMember(w http.ResponseWriter, r *http.Request) {
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	kind, idStr, ok := parseMemberRef(chi.URLParam(r, "memberRef"))
	if !ok {
		writeError(w, http.StatusBadRequest, "bad memberRef")
		return
	}
	memberID, ok := parseUUIDOrBadRequest(w, idStr, "id")
	if !ok {
		return
	}
	if err := h.Queries.RemoveChannelMember(r.Context(), db.RemoveChannelMemberParams{
		ChannelID: channelUUID, MemberType: kind, MemberID: memberID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ListChannelMembers(w http.ResponseWriter, r *http.Request) {
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	rows, err := h.Queries.ListChannelMembers(r.Context(), channelUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	if rows == nil {
		rows = []db.ChannelMember{}
	}
	_ = json.NewEncoder(w).Encode(rows)
}
```

- [ ] **Step 5: Mount member routes**

In `handler.go`, inside the `channels` subrouter:

```go
r.Get("/{channelID}/members", h.ListChannelMembers)
r.Put("/{channelID}/members/{memberRef}", h.PutChannelMember)
r.Delete("/{channelID}/members/{memberRef}", h.DeleteChannelMember)
```

- [ ] **Step 6: Run tests; verify pass**

```bash
cd server && go test ./internal/handler/ -run TestAddRemoveChannelMember -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel.go server/internal/handler/channel_test.go server/internal/handler/handler.go
git commit -m "feat(server): channel members CRUD (humans only in phase A)"
```

---

### Task A.6 — Channel messages: create + list main timeline

**Files:**
- Create: `server/internal/handler/channel_message.go`
- Create: `server/internal/handler/channel_message_test.go`
- Modify: `server/pkg/db/queries/channel.sql`
- Modify: `server/internal/handler/handler.go`

- [ ] **Step 1: Add message queries**

Append to `channel.sql`:

```sql
-- name: InsertChannelMessage :one
INSERT INTO channel_message (channel_id, author_type, author_id, body, parent_message_id, mentions, delivery_status, task_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: ListChannelMainMessages :many
-- Cursor-paginated: returns messages strictly older than cursor_created_at (or all if NULL).
SELECT * FROM channel_message
WHERE channel_id = $1
  AND parent_message_id IS NULL
  AND (sqlc.narg('cursor_created_at')::timestamptz IS NULL OR created_at < sqlc.narg('cursor_created_at'))
ORDER BY created_at DESC
LIMIT $2;

-- name: GetChannelMessage :one
SELECT * FROM channel_message WHERE id = $1;
```

Run `make sqlc`.

- [ ] **Step 2: Write failing tests**

`server/internal/handler/channel_message_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSendChannelMessage(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "msg-test", "public")
	body := strings.NewReader(`{"body":"hello world"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/messages", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got["body"] != "hello world" {
		t.Errorf("body=%v", got["body"])
	}
	if got["author_type"] != "member" {
		t.Errorf("author_type=%v", got["author_type"])
	}
}

func TestListChannelMessages_OrderDesc(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "list-msg-test", "public")
	for _, txt := range []string{"first", "second", "third"} {
		req := newAuthedRequest(t, http.MethodPost,
			"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/messages",
			strings.NewReader(`{"body":"`+txt+`"}`))
		rr := httptest.NewRecorder()
		testHandler.ServeHTTP(rr, req)
		if rr.Code != http.StatusCreated {
			t.Fatalf("seed: %d %s", rr.Code, rr.Body.String())
		}
	}
	listReq := newAuthedRequest(t, http.MethodGet,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/messages?limit=10", nil)
	listRR := httptest.NewRecorder()
	testHandler.ServeHTTP(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list: %d", listRR.Code)
	}
	var msgs []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&msgs)
	if len(msgs) != 3 {
		t.Fatalf("want 3, got %d", len(msgs))
	}
	if msgs[0]["body"] != "third" {
		t.Errorf("expected newest first, got %v", msgs[0]["body"])
	}
}
```

- [ ] **Step 3: Run; verify failure**

```bash
cd server && go test ./internal/handler/ -run "TestSendChannelMessage|TestListChannelMessages" -v
```
Expected: FAIL.

- [ ] **Step 4: Implement handler**

`channel_message.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/folio-ai/folio/server/pkg/db/generated"
)

type SendChannelMessageRequest struct {
	Body            string  `json:"body"`
	ParentMessageID *string `json:"parent_message_id"`
}

func (h *Handler) SendChannelMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id")
	if !ok {
		return
	}
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	var req SendChannelMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Body == "" {
		writeError(w, http.StatusBadRequest, "body is required")
		return
	}
	memberID, err := h.Queries.GetMemberIDForUser(r.Context(), db.GetMemberIDForUserParams{
		WorkspaceID: workspaceUUID, UserID: userID,
	})
	if err != nil {
		writeError(w, http.StatusForbidden, "not a workspace member")
		return
	}

	var parent pgtype.UUID
	if req.ParentMessageID != nil && *req.ParentMessageID != "" {
		pu, err := uuid.Parse(*req.ParentMessageID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad parent_message_id")
			return
		}
		parent = pgtype.UUID{Bytes: pu, Valid: true}
	}

	msg, err := h.Queries.InsertChannelMessage(r.Context(), db.InsertChannelMessageParams{
		ChannelID:       channelUUID,
		AuthorType:      "member",
		AuthorID:        memberID,
		Body:            req.Body,
		ParentMessageID: parent,
		Mentions:        []byte("[]"),
		DeliveryStatus:  "complete",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "insert failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(msg)
}

func (h *Handler) ListChannelMessages(w http.ResponseWriter, r *http.Request) {
	channelUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "channelID"), "channelID")
	if !ok {
		return
	}
	limit := int32(50)
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = int32(n)
		}
	}
	var cursor pgtype.Timestamptz
	if c := r.URL.Query().Get("cursor"); c != "" {
		if t, err := time.Parse(time.RFC3339Nano, c); err == nil {
			cursor = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	rows, err := h.Queries.ListChannelMainMessages(r.Context(), db.ListChannelMainMessagesParams{
		ChannelID: channelUUID, CursorCreatedAt: cursor, Limit: limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	if rows == nil {
		rows = []db.ChannelMessage{}
	}
	_ = json.NewEncoder(w).Encode(rows)
}
```

- [ ] **Step 5: Mount routes**

In channels subrouter:

```go
r.Post("/{channelID}/messages", h.SendChannelMessage)
r.Get("/{channelID}/messages", h.ListChannelMessages)
```

- [ ] **Step 6: Run tests; verify pass**

```bash
cd server && go test ./internal/handler/ -run "TestSendChannelMessage|TestListChannelMessages" -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel_message.go server/internal/handler/channel_message_test.go server/internal/handler/handler.go
git commit -m "feat(server): channel messages — send + list main timeline"
```

---

### Task A.7 — Frontend: API client + core/channels types & queries

**Files:**
- Create: `packages/core/types/channel.ts`
- Modify: `packages/core/api/index.ts` (or wherever `api` is composed) — add channel methods
- Create: `packages/core/channels/index.ts`
- Create: `packages/core/channels/queries.ts`
- Create: `packages/core/channels/queries.test.ts`

- [ ] **Step 1: Define types**

`packages/core/types/channel.ts`:

```ts
export type ChannelKind = "public" | "private" | "group_dm";
export type SubscribeMode = "mention_only" | "subscribe";
export type ChannelMemberType = "member" | "agent";
export type DeliveryStatus = "streaming" | "complete" | "failed";

export interface Channel {
  id: string;
  workspace_id: string;
  name: string | null;
  kind: ChannelKind;
  topic: string | null;
  creator_member_id: string;
  archived_at: string | null;
  default_subscribe_mode: SubscribeMode;
  agent_cooldown_ms: number;
  max_consecutive_agent_turns: number;
  consecutive_agent_turns: number;
  created_at: string;
  updated_at: string;
}

export interface ChannelMember {
  id: string;
  channel_id: string;
  member_type: ChannelMemberType;
  member_id: string;
  subscribe_mode: SubscribeMode | null;
  last_replied_at: string | null;
  joined_at: string;
}

export interface ChannelMention {
  type: ChannelMemberType;
  id: string;
}

export interface ChannelMessage {
  id: string;
  channel_id: string;
  author_type: ChannelMemberType;
  author_id: string;
  body: string;
  parent_message_id: string | null;
  mentions: ChannelMention[];
  reply_count: number;
  last_reply_at: string | null;
  reply_participants: ChannelMention[];
  delivery_status: DeliveryStatus;
  failure_reason: string | null;
  task_id: string | null;
  created_at: string;
  edited_at: string | null;
}

export interface ChannelReaction {
  id: string;
  message_id: string;
  reactor_type: ChannelMemberType;
  reactor_id: string;
  emoji: string;
  created_at: string;
}
```

- [ ] **Step 2: Extend the API client**

Find the existing `ApiClient` in `packages/core/api/`. Add methods (mirroring the chat methods):

```ts
listChannels(): Promise<Channel[]> {
  return this.get<Channel[]>(`/channels`);
}
createChannel(input: {
  name?: string; kind: ChannelKind; topic?: string;
  default_subscribe_mode?: SubscribeMode;
  agent_cooldown_ms?: number; max_consecutive_agent_turns?: number;
}): Promise<Channel> { return this.post(`/channels`, input); }
getChannel(id: string): Promise<Channel> { return this.get(`/channels/${id}`); }
patchChannel(id: string, input: Partial<...>): Promise<Channel> { return this.patch(`/channels/${id}`, input); }
archiveChannel(id: string): Promise<void> { return this.delete(`/channels/${id}`); }

listChannelMembers(channelID: string): Promise<ChannelMember[]> {
  return this.get(`/channels/${channelID}/members`);
}
putChannelMember(channelID: string, memberRef: string, body: { subscribe_mode?: SubscribeMode } = {}): Promise<ChannelMember> {
  return this.put(`/channels/${channelID}/members/${memberRef}`, body);
}
removeChannelMember(channelID: string, memberRef: string): Promise<void> {
  return this.delete(`/channels/${channelID}/members/${memberRef}`);
}

sendChannelMessage(channelID: string, body: string, parentMessageID?: string): Promise<ChannelMessage> {
  return this.post(`/channels/${channelID}/messages`, { body, parent_message_id: parentMessageID });
}
listChannelMessages(channelID: string, opts: { cursor?: string; limit?: number } = {}): Promise<ChannelMessage[]> {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.limit) q.set("limit", String(opts.limit));
  return this.get(`/channels/${channelID}/messages${q.toString() ? "?" + q : ""}`);
}
```

> Use the existing `this.get/post/put/patch/delete` shape in `ApiClient`. Imports for the types come from `../types/channel`.

- [ ] **Step 3: Write the queries module + a small test**

`packages/core/channels/queries.ts`:

```ts
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const channelKeys = {
  all: (wsId: string) => ["channels", wsId] as const,
  list: (wsId: string) => [...channelKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) => [...channelKeys.all(wsId), "detail", id] as const,
  members: (wsId: string, id: string) => [...channelKeys.all(wsId), "members", id] as const,
  messages: (channelId: string) => ["channel", "messages", channelId] as const,
  thread: (channelId: string, parentId: string) => ["channel", "thread", channelId, parentId] as const,
};

export const channelListOptions = (wsId: string) =>
  queryOptions({
    queryKey: channelKeys.list(wsId),
    queryFn: () => api.listChannels(),
    staleTime: Infinity,
  });

export const channelDetailOptions = (wsId: string, id: string) =>
  queryOptions({
    queryKey: channelKeys.detail(wsId, id),
    queryFn: () => api.getChannel(id),
    staleTime: Infinity,
  });

export const channelMembersOptions = (wsId: string, id: string) =>
  queryOptions({
    queryKey: channelKeys.members(wsId, id),
    queryFn: () => api.listChannelMembers(id),
    staleTime: Infinity,
  });

export const channelMessagesOptions = (channelId: string) =>
  queryOptions({
    queryKey: channelKeys.messages(channelId),
    queryFn: () => api.listChannelMessages(channelId, { limit: 50 }),
    staleTime: Infinity,
  });
```

`packages/core/channels/queries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { channelKeys } from "./queries";

describe("channelKeys", () => {
  it("derives stable list key per workspace", () => {
    expect(channelKeys.list("ws-1")).toEqual(["channels", "ws-1", "list"]);
  });
  it("derives a detail key per channel", () => {
    expect(channelKeys.detail("ws-1", "ch-1")).toEqual(["channels", "ws-1", "detail", "ch-1"]);
  });
  it("derives messages key independent of workspace (channelId is unique)", () => {
    expect(channelKeys.messages("ch-1")).toEqual(["channel", "messages", "ch-1"]);
  });
});
```

`packages/core/channels/index.ts`:

```ts
export * from "./queries";
export * from "./mutations";
export * from "./store";
export * from "./ws-updaters";
```

- [ ] **Step 4: Run tests; verify pass**

```bash
pnpm --filter @folio/core exec vitest run channels/queries.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/types/channel.ts packages/core/api/ packages/core/channels/
git commit -m "feat(core): channel types + queries + key factory"
```

---

### Task A.8 — Frontend: mutations + store + index

**Files:**
- Create: `packages/core/channels/mutations.ts`
- Create: `packages/core/channels/store.ts`
- Create: `packages/core/channels/mutations.test.ts`

- [ ] **Step 1: Write mutations**

`packages/core/channels/mutations.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../platform/workspace";
import { channelKeys } from "./queries";
import type { Channel, ChannelKind, ChannelMessage, SubscribeMode } from "../types/channel";

export function useCreateChannel() {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; kind: ChannelKind; topic?: string }) =>
      api.createChannel(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: channelKeys.list(wsId) }),
  });
}

export function useArchiveChannel() {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveChannel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: channelKeys.list(wsId) }),
  });
}

export function useSendChannelMessage(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: string; parentMessageId?: string }) =>
      api.sendChannelMessage(channelId, vars.body, vars.parentMessageId),
    onMutate: async (vars) => {
      const key = channelKeys.messages(channelId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ChannelMessage[]>(key) ?? [];
      const optimistic: ChannelMessage = {
        id: `optimistic-${Date.now()}`,
        channel_id: channelId,
        author_type: "member",
        author_id: "self", // replaced on settle by real row
        body: vars.body,
        parent_message_id: vars.parentMessageId ?? null,
        mentions: [],
        reply_count: 0,
        last_reply_at: null,
        reply_participants: [],
        delivery_status: "complete",
        failure_reason: null,
        task_id: null,
        created_at: new Date().toISOString(),
        edited_at: null,
      };
      qc.setQueryData<ChannelMessage[]>(key, [optimistic, ...prev]);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(channelKeys.messages(channelId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
    },
  });
}

export function useUpsertChannelMember(channelId: string) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memberRef: string; subscribe_mode?: SubscribeMode }) =>
      api.putChannelMember(channelId, vars.memberRef, { subscribe_mode: vars.subscribe_mode }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: channelKeys.members(wsId, channelId) }),
  });
}

export function useRemoveChannelMember(channelId: string) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberRef: string) => api.removeChannelMember(channelId, memberRef),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: channelKeys.members(wsId, channelId) }),
  });
}
```

- [ ] **Step 2: Write store**

`packages/core/channels/store.ts`:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ChannelClientState {
  drafts: Record<string, string>;        // channelId -> composer draft
  openThreadByChannel: Record<string, string | null>;
  setDraft: (channelId: string, body: string) => void;
  clearDraft: (channelId: string) => void;
  openThread: (channelId: string, parentId: string) => void;
  closeThread: (channelId: string) => void;
}

export const useChannelClientStore = create<ChannelClientState>()(
  persist(
    (set) => ({
      drafts: {},
      openThreadByChannel: {},
      setDraft: (channelId, body) =>
        set((s) => ({ drafts: { ...s.drafts, [channelId]: body } })),
      clearDraft: (channelId) =>
        set((s) => {
          const { [channelId]: _, ...rest } = s.drafts;
          return { drafts: rest };
        }),
      openThread: (channelId, parentId) =>
        set((s) => ({ openThreadByChannel: { ...s.openThreadByChannel, [channelId]: parentId } })),
      closeThread: (channelId) =>
        set((s) => ({ openThreadByChannel: { ...s.openThreadByChannel, [channelId]: null } })),
    }),
    { name: "folio-channels-client" }
  )
);
```

- [ ] **Step 3: Write a draft-store test**

`packages/core/channels/mutations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useChannelClientStore } from "./store";

describe("useChannelClientStore", () => {
  beforeEach(() => {
    useChannelClientStore.setState({ drafts: {}, openThreadByChannel: {} });
  });

  it("sets and clears drafts", () => {
    useChannelClientStore.getState().setDraft("c1", "hi");
    expect(useChannelClientStore.getState().drafts["c1"]).toBe("hi");
    useChannelClientStore.getState().clearDraft("c1");
    expect(useChannelClientStore.getState().drafts["c1"]).toBeUndefined();
  });

  it("opens and closes threads independently per channel", () => {
    useChannelClientStore.getState().openThread("c1", "p1");
    useChannelClientStore.getState().openThread("c2", "p2");
    expect(useChannelClientStore.getState().openThreadByChannel).toEqual({ c1: "p1", c2: "p2" });
    useChannelClientStore.getState().closeThread("c1");
    expect(useChannelClientStore.getState().openThreadByChannel.c1).toBeNull();
    expect(useChannelClientStore.getState().openThreadByChannel.c2).toBe("p2");
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @folio/core exec vitest run channels
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/channels/
git commit -m "feat(core): channel mutations + client store"
```

---

### Task A.9 — Views: minimal channel UI

**Files:**
- Create: `packages/views/channels/components/channel-view.tsx`
- Create: `packages/views/channels/components/channel-message-list.tsx`
- Create: `packages/views/channels/components/channel-message.tsx`
- Create: `packages/views/channels/components/channel-composer.tsx`
- Create: `packages/views/channels/components/channel-create-dialog.tsx`
- Create: `packages/views/channels/components/channel-list-sidebar.tsx`
- Create: `packages/views/channels/index.ts`

- [ ] **Step 1: `channel-message.tsx`**

```tsx
import { type ChannelMessage } from "@folio/core/types/channel";
import { cn } from "@folio/ui";

export function ChannelMessageRow({ msg }: { msg: ChannelMessage }) {
  return (
    <li
      data-testid="channel-message"
      className={cn(
        "px-4 py-2 text-sm flex flex-col gap-0.5",
        msg.delivery_status === "streaming" && "opacity-70",
        msg.delivery_status === "failed" && "bg-destructive/10 border-l-2 border-destructive"
      )}
    >
      <div className="text-xs text-muted-foreground">
        {msg.author_type === "agent" ? "[agent]" : "[member]"} · {msg.author_id.slice(0, 8)} ·{" "}
        {new Date(msg.created_at).toLocaleTimeString()}
      </div>
      <div className="whitespace-pre-wrap">{msg.body}</div>
    </li>
  );
}
```

- [ ] **Step 2: `channel-message-list.tsx`**

```tsx
import { useSuspenseQuery } from "@tanstack/react-query";
import { channelMessagesOptions } from "@folio/core/channels";
import { ChannelMessageRow } from "./channel-message";

export function ChannelMessageList({ channelId }: { channelId: string }) {
  const { data: messages } = useSuspenseQuery(channelMessagesOptions(channelId));
  // newest-first from API; reverse for chronological top→bottom display.
  const ordered = [...messages].reverse();
  return (
    <ul data-testid="channel-message-list" className="flex-1 overflow-y-auto py-2">
      {ordered.length === 0 ? (
        <li className="text-muted-foreground text-sm px-4 py-8 text-center">
          No messages yet. Say hi 👋
        </li>
      ) : (
        ordered.map((m) => <ChannelMessageRow key={m.id} msg={m} />)
      )}
    </ul>
  );
}
```

- [ ] **Step 3: `channel-composer.tsx`**

```tsx
import { useState } from "react";
import { Button, Textarea } from "@folio/ui";
import { useSendChannelMessage, useChannelClientStore } from "@folio/core/channels";

export function ChannelComposer({ channelId }: { channelId: string }) {
  const draft = useChannelClientStore((s) => s.drafts[channelId] ?? "");
  const setDraft = useChannelClientStore((s) => s.setDraft);
  const clearDraft = useChannelClientStore((s) => s.clearDraft);
  const send = useSendChannelMessage(channelId);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    const body = draft.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      await send.mutateAsync({ body });
      clearDraft(channelId);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t p-2 flex gap-2">
      <Textarea
        data-testid="channel-composer-textarea"
        value={draft}
        onChange={(e) => setDraft(channelId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void onSubmit();
          }
        }}
        placeholder="Write a message…"
        rows={2}
      />
      <Button onClick={() => void onSubmit()} disabled={submitting || !draft.trim()}>
        Send
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: `channel-view.tsx`**

```tsx
import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { channelDetailOptions } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/platform/workspace";
import { ChannelMessageList } from "./channel-message-list";
import { ChannelComposer } from "./channel-composer";

export function ChannelView({ channelId }: { channelId: string }) {
  const wsId = useWorkspaceId();
  const { data: channel } = useSuspenseQuery(channelDetailOptions(wsId, channelId));
  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-4 py-2">
        <h1 className="text-lg font-semibold">
          {channel.kind === "group_dm" ? "Direct message" : `# ${channel.name}`}
        </h1>
        {channel.topic && <p className="text-sm text-muted-foreground">{channel.topic}</p>}
      </header>
      <Suspense fallback={<div className="flex-1 grid place-items-center text-muted-foreground">Loading…</div>}>
        <ChannelMessageList channelId={channelId} />
      </Suspense>
      <ChannelComposer channelId={channelId} />
    </div>
  );
}
```

- [ ] **Step 5: `channel-create-dialog.tsx` + `channel-list-sidebar.tsx`**

`channel-create-dialog.tsx`:

```tsx
import { useState } from "react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, RadioGroup, RadioGroupItem } from "@folio/ui";
import { useCreateChannel } from "@folio/core/channels";

export function ChannelCreateDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const create = useCreateChannel();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New channel</DialogTitle></DialogHeader>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="general" />
        <Label>Visibility</Label>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
          <div className="flex gap-3 items-center"><RadioGroupItem value="public" id="vp" /><Label htmlFor="vp">Public</Label></div>
          <div className="flex gap-3 items-center"><RadioGroupItem value="private" id="vr" /><Label htmlFor="vr">Private</Label></div>
        </RadioGroup>
        <Button
          disabled={!name.trim() || create.isPending}
          onClick={async () => {
            const c = await create.mutateAsync({ name: name.trim(), kind });
            onOpenChange(false);
            onCreated?.(c.id);
          }}
        >
          Create
        </Button>
      </DialogContent>
    </Dialog>
  );
}
```

`channel-list-sidebar.tsx`:

```tsx
import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Button } from "@folio/ui";
import { useNavigation } from "@folio/core/platform/navigation";
import { useWorkspaceId } from "@folio/core/platform/workspace";
import { channelListOptions } from "@folio/core/channels";
import { ChannelCreateDialog } from "./channel-create-dialog";

export function ChannelListSidebar() {
  const wsId = useWorkspaceId();
  const nav = useNavigation();
  const { data: channels } = useSuspenseQuery(channelListOptions(wsId));
  const [creating, setCreating] = useState(false);

  return (
    <div className="px-2 py-3 flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Channels</span>
        <Button size="icon" variant="ghost" onClick={() => setCreating(true)} aria-label="New channel">+</Button>
      </div>
      {channels.map((c) => (
        <button
          key={c.id}
          onClick={() => nav.go(`/channels/${c.id}`)}
          className="text-left px-2 py-1 rounded hover:bg-accent text-sm"
        >
          {c.kind === "group_dm" ? "DM" : `# ${c.name}`}
        </button>
      ))}
      <ChannelCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => nav.go(`/channels/${id}`)}
      />
    </div>
  );
}
```

`packages/views/channels/index.ts`:

```ts
export * from "./components/channel-view";
export * from "./components/channel-list-sidebar";
export * from "./components/channel-create-dialog";
```

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/views/channels/
git commit -m "feat(views): minimal channel UI — list, view, composer, create dialog"
```

---

### Task A.10 — Wire routes + sidebar in `apps/web` and `apps/desktop`

**Files:**
- Create: `apps/web/app/[workspaceSlug]/(dashboard)/channels/page.tsx`
- Create: `apps/web/app/[workspaceSlug]/(dashboard)/channels/[channelId]/page.tsx`
- Modify: existing sidebar component (find it via `grep -r "InboxSection\|inbox" packages/views/sidebar/`)
- Modify: `apps/desktop/src/renderer/src/routes.tsx`

- [ ] **Step 1: web list page**

`apps/web/app/[workspaceSlug]/(dashboard)/channels/page.tsx`:

```tsx
"use client";
import { useSuspenseQuery } from "@tanstack/react-query";
import { channelListOptions } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/platform/workspace";

export default function ChannelsListPage() {
  const wsId = useWorkspaceId();
  const { data: channels } = useSuspenseQuery(channelListOptions(wsId));
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Channels</h1>
      <ul className="grid gap-2">
        {channels.map((c) => (
          <li key={c.id}>
            <a href={`./channels/${c.id}`} className="block p-3 rounded border hover:bg-accent">
              {c.kind === "group_dm" ? "Direct message" : `# ${c.name}`}
              {c.topic && <div className="text-sm text-muted-foreground">{c.topic}</div>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: web detail page**

`apps/web/app/[workspaceSlug]/(dashboard)/channels/[channelId]/page.tsx`:

```tsx
"use client";
import { useParams } from "next/navigation";
import { ChannelView } from "@folio/views/channels";

export default function ChannelDetailPage() {
  const { channelId } = useParams<{ channelId: string }>();
  return <ChannelView channelId={channelId} />;
}
```

- [ ] **Step 3: Add Channels section to sidebar**

Find the sidebar (likely `packages/views/sidebar/sidebar.tsx` or `apps/web/app/[workspaceSlug]/(dashboard)/_layout/sidebar.tsx`). Add the import:

```tsx
import { ChannelListSidebar } from "@folio/views/channels";
```

And mount it above the existing Inbox section:

```tsx
<ChannelListSidebar />
```

- [ ] **Step 4: Add desktop route**

In `apps/desktop/src/renderer/src/routes.tsx`, add a route entry mirroring how `chat` is registered:

```tsx
{ path: "channels", element: <Suspense fallback={null}><ChannelsListPage/></Suspense> },
{ path: "channels/:channelId", element: <Suspense fallback={null}><ChannelDetailPage/></Suspense> },
```

- [ ] **Step 5: Manual smoke test**

Run:
```bash
make dev
```
- Open http://localhost:3000, log in, switch to a workspace.
- Click "+ New channel", create "general" public.
- Click "general" in sidebar → channel view loads.
- Type "hello" → Enter. Message appears.
- Refresh page. Message persists.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/[workspaceSlug]/\(dashboard\)/channels/ packages/views/sidebar/ apps/desktop/src/renderer/src/routes.tsx
git commit -m "feat(web,desktop): channels routes + sidebar entry"
```

---

### Task A.11 — Phase A E2E smoke

**Files:**
- Create: `e2e/tests/channels-basic.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from "@playwright/test";
import { signInAndGotoWorkspace } from "./helpers/auth";

test("create a channel, post a message, list reflects", async ({ page }) => {
  await signInAndGotoWorkspace(page);

  await page.getByRole("button", { name: "New channel" }).click();
  await page.getByLabel("Name").fill("e2e-basic");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: "# e2e-basic" })).toBeVisible();

  await page.getByTestId("channel-composer-textarea").fill("hello from playwright");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("channel-message").last()).toContainText("hello from playwright");

  // Reload — message persists.
  await page.reload();
  await expect(page.getByTestId("channel-message").last()).toContainText("hello from playwright");
});
```

> If `signInAndGotoWorkspace` doesn't exist, copy the pattern from another e2e test (e.g. `e2e/tests/chat.spec.ts` or similar). It's a thin wrapper around the auth flow.

- [ ] **Step 2: Run e2e**

Run:
```bash
make dev   # in one terminal
pnpm exec playwright test e2e/tests/channels-basic.spec.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/channels-basic.spec.ts
git commit -m "test(e2e): channels basic smoke (Phase A)"
```

---

## Phase B — Realtime broadcast

### Task B.1 — Define typed channel events on the server

**Files:**
- Create: `server/internal/events/channel_events.go`
- Modify: places that already use `events.Bus` — find them with `grep -rn "events.Event{Kind:" server/internal/handler/`

- [ ] **Step 1: Add event constructors**

`server/internal/events/channel_events.go`:

```go
package events

import (
	"encoding/json"

	db "github.com/folio-ai/folio/server/pkg/db/generated"
)

const (
	KindChannelCreated         = "channel.created"
	KindChannelUpdated         = "channel.updated"
	KindChannelArchived        = "channel.archived"
	KindChannelMemberAdded     = "channel.member.added"
	KindChannelMemberRemoved   = "channel.member.removed"
	KindChannelMessageCreated  = "channel.message.created"
	KindChannelMessagePatched  = "channel.message.patched"
	KindChannelMessageComplete = "channel.message.completed"
	KindChannelThreadRollup    = "channel.thread.rollup"
	KindChannelReactionAdded   = "channel.reaction.added"
	KindChannelReactionRemoved = "channel.reaction.removed"
)

func ChannelMessageCreated(workspaceID string, msg db.ChannelMessage) Event {
	payload, _ := json.Marshal(msg)
	return Event{
		Kind:        KindChannelMessageCreated,
		WorkspaceID: workspaceID,
		Payload:     payload,
	}
}

// (similar one-liner constructors for the other Kinds — keep it boring)
```

> If `events.Event` has a different field shape, adapt — use the existing constructors as your template (e.g. for `inbox_item` events).

- [ ] **Step 2: Compile-check**

```bash
cd server && go build ./...
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/internal/events/channel_events.go
git commit -m "feat(events): typed channel event kinds + constructors"
```

---

### Task B.2 — Broadcast on message create

**Files:**
- Modify: `server/internal/handler/channel_message.go`

- [ ] **Step 1: Write a test that verifies the bus saw the event**

Append to `channel_message_test.go`:

```go
func TestSendChannelMessage_PublishesEvent(t *testing.T) {
	if testHandler == nil || testEventBus == nil {
		t.Skip("database/bus not available")
	}
	c := mustCreateChannel(t, "broadcast-test", "public")
	sub := testEventBus.SubscribeAll() // see existing test patterns; or use a recorder
	defer sub.Close()

	body := strings.NewReader(`{"body":"ping"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/messages", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)

	got := waitForEvent(t, sub, "channel.message.created", 2*time.Second)
	if got == nil {
		t.Fatal("expected channel.message.created event")
	}
}
```

> `testEventBus`, `SubscribeAll`, `waitForEvent` follow the pattern used by existing inbox/issue handler tests (look at `inbox_test.go` if it exists; otherwise build a tiny synchronous bus recorder helper in `handler_test.go`).

- [ ] **Step 2: Run; verify failure**

```bash
cd server && go test ./internal/handler/ -run TestSendChannelMessage_PublishesEvent -v
```
Expected: FAIL.

- [ ] **Step 3: Wire publish in `SendChannelMessage`**

After the successful `InsertChannelMessage`, before returning:

```go
h.Bus.Publish(events.ChannelMessageCreated(workspaceID, msg))
```

Add `"github.com/folio-ai/folio/server/internal/events"` to imports.

- [ ] **Step 4: Run; verify pass**

```bash
cd server && go test ./internal/handler/ -run TestSendChannelMessage_PublishesEvent -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/channel_message.go server/internal/handler/channel_message_test.go
git commit -m "feat(server): publish channel.message.created on insert"
```

---

### Task B.3 — Frontend WS updaters

**Files:**
- Create: `packages/core/channels/ws-updaters.ts`
- Create: `packages/core/channels/ws-updaters.test.ts`
- Modify: wherever WS dispatch is wired — find via `grep -rn "ws-updaters\|registerWsHandlers" packages/core/`

- [ ] **Step 1: Implement updaters**

`packages/core/channels/ws-updaters.ts`:

```ts
import type { QueryClient } from "@tanstack/react-query";
import { channelKeys } from "./queries";

type Event =
  | { kind: "channel.created" | "channel.updated" | "channel.archived"; workspace_id: string }
  | { kind: "channel.member.added" | "channel.member.removed";
      workspace_id: string; channel_id: string }
  | { kind: "channel.message.created" | "channel.message.patched" | "channel.message.completed";
      workspace_id: string; channel_id: string }
  | { kind: "channel.thread.rollup";
      workspace_id: string; channel_id: string; parent_id: string }
  | { kind: "channel.reaction.added" | "channel.reaction.removed";
      workspace_id: string; channel_id: string; message_id: string };

export function applyChannelEvent(qc: QueryClient, e: Event) {
  switch (e.kind) {
    case "channel.created":
    case "channel.updated":
    case "channel.archived":
      qc.invalidateQueries({ queryKey: channelKeys.list(e.workspace_id) });
      break;
    case "channel.member.added":
    case "channel.member.removed":
      qc.invalidateQueries({ queryKey: channelKeys.members(e.workspace_id, e.channel_id) });
      qc.invalidateQueries({ queryKey: channelKeys.list(e.workspace_id) });
      break;
    case "channel.message.created":
    case "channel.message.patched":
    case "channel.message.completed":
      qc.invalidateQueries({ queryKey: channelKeys.messages(e.channel_id) });
      break;
    case "channel.thread.rollup":
      qc.invalidateQueries({ queryKey: channelKeys.messages(e.channel_id) });
      qc.invalidateQueries({ queryKey: channelKeys.thread(e.channel_id, e.parent_id) });
      break;
    case "channel.reaction.added":
    case "channel.reaction.removed":
      qc.invalidateQueries({ queryKey: channelKeys.messages(e.channel_id) });
      qc.invalidateQueries({ queryKey: ["channel", "reactions", e.message_id] });
      break;
  }
}
```

`packages/core/channels/ws-updaters.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyChannelEvent } from "./ws-updaters";

describe("applyChannelEvent", () => {
  it("invalidates messages query on channel.message.created", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      kind: "channel.message.created",
      workspace_id: "ws-1",
      channel_id: "ch-1",
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["channel", "messages", "ch-1"] });
  });

  it("invalidates list and members on member.added", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyChannelEvent(qc, {
      kind: "channel.member.added",
      workspace_id: "ws-1",
      channel_id: "ch-1",
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Register at WS dispatch**

Find the central WS dispatcher (look for the place that calls `applyInboxEvent` or similar). Add a route for events whose `kind` starts with `channel.`:

```ts
import { applyChannelEvent } from "../channels/ws-updaters";

// inside the existing switch on event.kind, or before a generic fallthrough:
if (event.kind.startsWith("channel.")) {
  applyChannelEvent(queryClient, event as any);
  return;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @folio/core exec vitest run channels/ws-updaters.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/channels/ws-updaters.ts packages/core/channels/ws-updaters.test.ts
git commit -m "feat(core): channel WS updaters route events to query invalidations"
```

---

### Task B.4 — Two-tab realtime smoke

**Files:**
- Modify: `e2e/tests/channels-basic.spec.ts` (new test case)

- [ ] **Step 1: Add the test**

```ts
test("realtime: tab B sees tab A's message without refresh", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await signInAndGotoWorkspace(a);
  await signInAndGotoWorkspace(b);

  // Tab A: create channel + post.
  await a.getByRole("button", { name: "New channel" }).click();
  await a.getByLabel("Name").fill("realtime-test");
  await a.getByRole("button", { name: "Create" }).click();
  await expect(a.getByRole("heading", { name: "# realtime-test" })).toBeVisible();

  // Tab B: navigate to the same channel via sidebar (channel.created event made it appear).
  await expect(b.getByRole("button", { name: "# realtime-test" })).toBeVisible();
  await b.getByRole("button", { name: "# realtime-test" }).click();

  // Tab A posts; Tab B sees it.
  await a.getByTestId("channel-composer-textarea").fill("realtime hello");
  await a.getByRole("button", { name: "Send" }).click();
  await expect(b.getByTestId("channel-message").last()).toContainText("realtime hello");
});
```

- [ ] **Step 2: Run**

```bash
pnpm exec playwright test e2e/tests/channels-basic.spec.ts
```
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/channels-basic.spec.ts
git commit -m "test(e2e): channels two-tab realtime"
```

---

## Phase C — Agent membership + dispatcher (mention_only)

### Task C.1 — Allow `agent` member type; mention parsing

**Files:**
- Modify: `server/internal/handler/channel.go` (lift the agent-rejection guard from Task A.5 Step 4)
- Modify: `server/internal/handler/channel_message.go` (parse `@<token>` patterns into `mentions`)
- Modify: `server/internal/handler/channel_test.go` and `channel_message_test.go`
- Modify: `server/pkg/db/queries/channel.sql` (helper to resolve `@name` to agent UUIDs in this workspace)

- [ ] **Step 1: sqlc helper to resolve @-handles**

```sql
-- name: ResolveWorkspaceMentions :many
-- Resolves any of the given handles (lower-cased agent names or member display
-- names) to {type, id} tuples. We accept TWO arrays so the caller can resolve
-- members and agents in one round-trip.
SELECT 'agent' AS type, id FROM agent
WHERE workspace_id = $1 AND lower(name) = ANY($2::text[])
UNION ALL
SELECT 'member' AS type, m.id FROM member m
JOIN "user" u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND lower(u.name) = ANY($3::text[]);
```

Run `make sqlc`.

- [ ] **Step 2: Failing test for mention parsing**

```go
func TestSendChannelMessage_ParsesAgentMention(t *testing.T) {
	if testHandler == nil { t.Skip("database not available") }
	c := mustCreateChannel(t, "mention-test", "public")
	a := createHandlerTestAgent(t, "claude", []byte(`{}`))

	body := strings.NewReader(`{"body":"hey @claude can you help"}`)
	req := newAuthedRequest(t, http.MethodPost,
		"/api/workspaces/"+testWorkspace.Slug+"/channels/"+c.ID+"/messages", body)
	rr := httptest.NewRecorder()
	testHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated { t.Fatalf("status=%d %s", rr.Code, rr.Body.String()) }
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)

	mentions, _ := got["mentions"].([]any)
	if len(mentions) != 1 { t.Fatalf("want 1 mention, got %d", len(mentions)) }
	first := mentions[0].(map[string]any)
	if first["type"] != "agent" { t.Errorf("type=%v", first["type"]) }
	if first["id"] != a.ID { t.Errorf("id=%v want %v", first["id"], a.ID) }
}
```

- [ ] **Step 3: Run; fail**

```bash
cd server && go test ./internal/handler/ -run TestSendChannelMessage_ParsesAgentMention -v
```

- [ ] **Step 4: Implement parsing**

In `channel_message.go`, before INSERT, extract handles via regex:

```go
import "regexp"

var mentionRe = regexp.MustCompile(`@([A-Za-z0-9_\-]+)`)

func extractMentionTokens(body string) []string {
	matches := mentionRe.FindAllStringSubmatch(body, -1)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range matches {
		t := strings.ToLower(m[1])
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}
```

In `SendChannelMessage`, after computing `req.Body`:

```go
tokens := extractMentionTokens(req.Body)
mentionsJSON := []byte("[]")
if len(tokens) > 0 {
    rows, err := h.Queries.ResolveWorkspaceMentions(r.Context(), db.ResolveWorkspaceMentionsParams{
        WorkspaceID: workspaceUUID,
        AgentNames:  tokens,
        MemberNames: tokens,
    })
    if err == nil && len(rows) > 0 {
        type m struct{ Type, ID string }
        ms := make([]m, 0, len(rows))
        for _, row := range rows {
            ms = append(ms, m{Type: row.Type, ID: row.ID.String()})
        }
        mentionsJSON, _ = json.Marshal(ms)
    }
}
```

Pass `mentionsJSON` into `InsertChannelMessage`.

- [ ] **Step 5: Lift the agent-member guard**

In `PutChannelMember` (Task A.5), delete the early `if kind == "agent" { reject }` block. Validate instead that the agent exists in the workspace via `h.Queries.GetAgentInWorkspace`.

- [ ] **Step 6: Run; pass**

```bash
cd server && go test ./internal/handler/ -run "TestSendChannelMessage_ParsesAgentMention|TestAddRemoveChannelMember" -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel.go server/internal/handler/channel_message.go server/internal/handler/channel_test.go server/internal/handler/channel_message_test.go
git commit -m "feat(server): parse @mentions; allow agent channel members"
```

---

### Task C.2 — Channel dispatcher (mention_only path)

**Files:**
- Create: `server/internal/agent/channel_dispatcher.go`
- Create: `server/internal/agent/channel_dispatcher_test.go`
- Modify: `server/pkg/db/queries/channel.sql` (queries the dispatcher needs)
- Modify: `server/internal/handler/channel_message.go` (call dispatcher after insert)

- [ ] **Step 1: Add dispatcher queries**

Append to `channel.sql`:

```sql
-- name: ListChannelAgentMembers :many
SELECT cm.*, c.default_subscribe_mode, c.agent_cooldown_ms, c.consecutive_agent_turns,
       c.max_consecutive_agent_turns
FROM channel_member cm
JOIN channel c ON c.id = cm.channel_id
WHERE cm.channel_id = $1 AND cm.member_type = 'agent';

-- name: UpdateAgentMemberAfterReply :exec
UPDATE channel_member
SET last_replied_at = now(),
    provider_session_id = COALESCE(sqlc.narg('provider_session_id'), provider_session_id),
    last_known_good_session_id = COALESCE(sqlc.narg('last_known_good_session_id'), last_known_good_session_id)
WHERE channel_id = sqlc.arg('channel_id')
  AND member_type = 'agent'
  AND member_id = sqlc.arg('agent_id');
```

Run `make sqlc`.

- [ ] **Step 2: Write dispatcher tests**

`channel_dispatcher_test.go`:

```go
package agent

import (
	"context"
	"testing"
)

func TestDispatch_MentionOnly_EnqueuesOnlyMentionedAgents(t *testing.T) {
	if testDB == nil { t.Skip("database not available") }
	ctx := context.Background()
	ws, ch := seedChannelWithTwoAgents(t)
	a1, a2 := ws.AgentA, ws.AgentB

	// a1 default mention_only, a2 default mention_only via channel default override
	setSubscribeMode(t, ch.ID, a1.ID, "mention_only")
	setSubscribeMode(t, ch.ID, a2.ID, "mention_only")

	msg := insertHumanMessage(t, ch.ID, "@"+a1.Name+" please help", []mentionRow{{Type: "agent", ID: a1.ID}})
	d := NewChannelDispatcher(testQueries, testTaskQueue)
	if err := d.Dispatch(ctx, msg); err != nil { t.Fatal(err) }

	enqueued := testTaskQueue.Drain()
	if len(enqueued) != 1 { t.Fatalf("want 1 task, got %d", len(enqueued)) }
	if enqueued[0].AgentID != a1.ID { t.Errorf("wrong agent") }
}
```

> `testDB`, `seedChannelWithTwoAgents`, `setSubscribeMode`, `insertHumanMessage`, `testTaskQueue` are local fixtures you build in `channel_dispatcher_test.go`'s `TestMain`. Mirror the patterns from `server/internal/agent/*_test.go` (or from `handler_test.go`).

- [ ] **Step 3: Run; fail**

```bash
cd server && go test ./internal/agent/ -run TestDispatch_MentionOnly -v
```

- [ ] **Step 4: Implement dispatcher**

`channel_dispatcher.go`:

```go
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/folio-ai/folio/server/pkg/db/generated"
)

type ChannelDispatcher struct {
	q    *db.Queries
	task TaskQueue // existing interface for enqueuing tasks
}

func NewChannelDispatcher(q *db.Queries, t TaskQueue) *ChannelDispatcher {
	return &ChannelDispatcher{q: q, task: t}
}

type mention struct{ Type, ID string }

func (d *ChannelDispatcher) Dispatch(ctx context.Context, msg db.ChannelMessage) error {
	var mentions []mention
	if len(msg.Mentions) > 0 {
		_ = json.Unmarshal(msg.Mentions, &mentions)
	}
	mentioned := map[string]bool{}
	for _, m := range mentions {
		if m.Type == "agent" {
			mentioned[m.ID] = true
		}
	}

	// 1. Maintain consecutive_agent_turns gate.
	if msg.AuthorType == "member" {
		if err := d.q.ResetConsecutiveAgentTurns(ctx, msg.ChannelID); err != nil {
			return err
		}
	} else if msg.AuthorType == "agent" {
		row, err := d.q.IncrementConsecutiveAgentTurns(ctx, msg.ChannelID)
		if err != nil { return err }
		if row.ConsecutiveAgentTurns >= row.MaxConsecutiveAgentTurns {
			return nil // gate closed; only @mention can bypass (handled below)
		}
	}

	// 2. List agent members + per-agent settings.
	rows, err := d.q.ListChannelAgentMembers(ctx, msg.ChannelID)
	if err != nil { return err }

	now := time.Now()
	for _, m := range rows {
		isMentioned := mentioned[m.MemberID.String()]
		if !isMentioned {
			mode := m.DefaultSubscribeMode
			if m.SubscribeMode.Valid {
				mode = m.SubscribeMode.String
			}
			if mode == "mention_only" { continue }
			// cooldown
			if m.LastRepliedAt.Valid && now.Sub(m.LastRepliedAt.Time) < time.Duration(m.AgentCooldownMs)*time.Millisecond {
				continue
			}
			// no self-reply
			if msg.AuthorType == "agent" && m.MemberID == msg.AuthorID { continue }
			// gate already enforced above for non-mention path
			if m.ConsecutiveAgentTurns >= m.MaxConsecutiveAgentTurns { continue }
		}

		ctxJSON, _ := json.Marshal(map[string]any{
			"channel_id":           msg.ChannelID.String(),
			"trigger_message_id":   msg.ID.String(),
			"parent_message_id":    nullableUUID(msg.ParentMessageID),
			"provider_session_id":  nullableText(m.ProviderSessionID),
		})
		priority := PriorityNormal
		if isMentioned { priority = PriorityHigh }

		if err := d.task.Enqueue(ctx, EnqueueParams{
			AgentID:     m.MemberID,
			ChannelID:   msg.ChannelID,    // new FK column on agent_task_queue
			Context:     ctxJSON,
			Priority:    priority,
		}); err != nil { return err }
	}
	return nil
}

func nullableUUID(u pgtype.UUID) *string {
	if !u.Valid { return nil }
	s := uuid.UUID(u.Bytes).String()
	return &s
}
func nullableText(t pgtype.Text) *string {
	if !t.Valid { return nil }
	return &t.String
}

var ErrGateClosed = errors.New("agent gate closed: max consecutive agent turns reached")
```

> `TaskQueue`, `EnqueueParams`, `PriorityNormal`/`PriorityHigh`: use the existing types in `server/internal/agent/` for the issue dispatcher. If they don't exist as a clean interface yet, factor them out — keep the change minimal (interface + a single adapter that wraps the existing implementation).

- [ ] **Step 5: Wire into message handler**

In `channel_message.go`, after publishing the event, call dispatch:

```go
if err := h.ChannelDispatcher.Dispatch(r.Context(), msg); err != nil {
    slog.Error("channel dispatch failed", "err", err)
    // Don't fail the request — the message is already saved.
}
```

Add `ChannelDispatcher *agent.ChannelDispatcher` to `Handler`. Wire it in the constructor.

- [ ] **Step 6: Run; pass**

```bash
cd server && go test ./internal/agent/ -run TestDispatch_MentionOnly -v
```

- [ ] **Step 7: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/agent/channel_dispatcher.go server/internal/agent/channel_dispatcher_test.go server/internal/handler/channel_message.go server/internal/handler/handler.go
git commit -m "feat(agent): channel dispatcher (mention-only path) + gate counters"
```

---

### Task C.3 — Daemon prompt template for channel context

**Files:**
- Modify: wherever the daemon builds prompts for tasks — find via `grep -rn "issue_id\|chat_session_id" server/internal/daemon/` (channel branches alongside those)
- Add: a new branch handling `kind='channel'`

- [ ] **Step 1: Locate the prompt builder**

Open the daemon's task-prompt builder (likely `server/internal/daemon/execenv/` or a `prompt.go`). It probably has a switch on `context.kind` for `issue`/`chat`.

- [ ] **Step 2: Add a `channel` branch (TDD test first)**

Add a unit test that builds a prompt for a fake channel context and asserts the prompt includes:
- The triggering message
- The last ~20 channel messages (or thread-only if `parent_message_id` set)
- The list of channel members (humans + agents) with their display names

```go
func TestBuildChannelPrompt_IncludesRecentHistory(t *testing.T) {
	ctx := context.Background()
	fake := newFakeChannelContext(t)
	got, err := BuildPrompt(ctx, fake.Queries, fake.TaskCtx)
	if err != nil { t.Fatal(err) }
	if !strings.Contains(got, fake.TriggerBody) { t.Error("trigger body missing") }
	if !strings.Contains(got, "[member]") { t.Error("member tag missing") }
	if !strings.Contains(got, "[agent]") { t.Error("agent tag missing") }
}

func TestBuildChannelPrompt_ThreadScope(t *testing.T) {
	fake := newFakeChannelContext(t)
	fake.TaskCtx["parent_message_id"] = fake.ParentID
	got, err := BuildPrompt(context.Background(), fake.Queries, fake.TaskCtx)
	if err != nil { t.Fatal(err) }
	if strings.Contains(got, fake.MainTimelineNoise) {
		t.Error("thread prompt must not include main timeline messages")
	}
}
```

- [ ] **Step 3: Run; fail**

```bash
cd server && go test ./internal/daemon/... -run TestBuildChannelPrompt -v
```

- [ ] **Step 4: Implement**

Add a `case "channel":` branch in `BuildPrompt`. If `parent_message_id` is set, fetch only that thread; otherwise fetch the most recent N main-timeline messages. Render each as `[<member|agent>] <name>: <body>`.

```go
case "channel":
    chanID := mustParseUUID(t, ctx["channel_id"])
    parentID, hasParent := parseUUIDPtr(ctx["parent_message_id"])
    var msgs []db.ChannelMessage
    if hasParent {
        msgs, _ = q.ListChannelThreadMessages(reqCtx, db.ListChannelThreadMessagesParams{
            ParentMessageID: pgtype.UUID{Bytes: parentID, Valid: true},
        })
    } else {
        msgs, _ = q.ListChannelMainMessages(reqCtx, db.ListChannelMainMessagesParams{
            ChannelID: pgtype.UUID{Bytes: chanID, Valid: true},
            Limit: 20,
        })
    }
    return renderChannelPrompt(msgs, q, chanID), nil
```

(`renderChannelPrompt` formats each message and prepends a system header naming the channel and listing its members.)

- [ ] **Step 5: Run; pass**

```bash
cd server && go test ./internal/daemon/... -run TestBuildChannelPrompt -v
```

- [ ] **Step 6: Commit**

```bash
git add server/internal/daemon/...
git commit -m "feat(daemon): channel prompt template (history scope respects parent_message_id)"
```

---

### Task C.4 — Streaming agent reply: row + delivery_status patches

**Files:**
- Modify: `server/internal/handler/channel_message.go` (new internal helper for agent replies)
- Modify: `server/pkg/db/queries/channel.sql` (UpdateMessageBody / FinalizeMessage)
- Modify: the daemon→server message-completion path

- [ ] **Step 1: Queries**

```sql
-- name: PrepareAgentChannelMessage :one
INSERT INTO channel_message (channel_id, author_type, author_id, body, parent_message_id, mentions,
                              delivery_status, task_id)
VALUES ($1, 'agent', $2, '', $3, '[]', 'streaming', $4)
RETURNING *;

-- name: AppendAgentChannelMessageBody :exec
UPDATE channel_message
SET body = body || $2
WHERE id = $1 AND delivery_status = 'streaming';

-- name: FinalizeAgentChannelMessage :exec
UPDATE channel_message
SET delivery_status = $2,
    failure_reason = $3,
    edited_at = CASE WHEN $2 = 'complete' THEN NULL ELSE edited_at END
WHERE id = $1;
```

Run `make sqlc`.

- [ ] **Step 2: Test for streaming flow**

```go
func TestAgentChannelReply_StreamingThenComplete(t *testing.T) {
	if testHandler == nil { t.Skip("database not available") }
	ch := mustCreateChannel(t, "stream-test", "public")
	a := createHandlerTestAgent(t, "stream-agent", []byte(`{}`))

	prepared, err := testHandler.PrepareAgentChannelMessage(context.Background(), ch.ID, a.ID, "task-1")
	if err != nil { t.Fatal(err) }
	if prepared.DeliveryStatus != "streaming" { t.Error("not streaming") }

	_ = testHandler.AppendAgentChannelMessageBody(context.Background(), prepared.ID, "Hello ")
	_ = testHandler.AppendAgentChannelMessageBody(context.Background(), prepared.ID, "world")
	_ = testHandler.FinalizeAgentChannelMessage(context.Background(), prepared.ID, "complete", "")

	got := mustGetChannelMessage(t, prepared.ID)
	if got.Body != "Hello world" { t.Errorf("body=%q", got.Body) }
	if got.DeliveryStatus != "complete" { t.Errorf("status=%v", got.DeliveryStatus) }
}
```

- [ ] **Step 3: Run; fail; implement helpers; run; pass**

Add `PrepareAgentChannelMessage / AppendAgentChannelMessageBody / FinalizeAgentChannelMessage` methods on `Handler` that wrap the sqlc calls and publish the corresponding events (`channel.message.created` on prepare; `channel.message.patched` per append, throttled at 100ms in the handler; `channel.message.completed` on finalize). The throttle: keep a `map[uuid]time.Time` of `lastPatchSent`; coalesce calls within 100ms into a single broadcast.

Wire the daemon's stream-event handler (likely `server/internal/handler/daemon_ws.go`) so that when a daemon reports per-token chunks for a task whose `agent_task_queue.channel_id` is non-null, it calls these methods.

- [ ] **Step 4: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel_message.go server/internal/handler/channel_message_test.go server/internal/handler/daemon_ws.go
git commit -m "feat(server): agent channel-message streaming (prepare/append/finalize) with throttled WS patches"
```

---

### Task C.5 — UI: add agent to channel; render agent author

**Files:**
- Modify: `packages/views/channels/components/channel-settings-panel.tsx` (new)
- Modify: `packages/views/channels/components/channel-message.tsx` (already has `[agent]` tag from A.9; verify)
- Modify: `packages/core/channels/mutations.ts` (already has `useUpsertChannelMember`)

- [ ] **Step 1: Build settings panel**

`channel-settings-panel.tsx`:

```tsx
import { useSuspenseQuery } from "@tanstack/react-query";
import { Button, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@folio/ui";
import { channelMembersOptions, useUpsertChannelMember, useRemoveChannelMember } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/platform/workspace";

export function ChannelSettingsPanel({ channelId }: { channelId: string }) {
  const wsId = useWorkspaceId();
  const { data: members } = useSuspenseQuery(channelMembersOptions(wsId, channelId));
  const upsert = useUpsertChannelMember(channelId);
  const remove = useRemoveChannelMember(channelId);
  return (
    <aside className="w-72 border-l p-3 flex flex-col gap-2">
      <h2 className="font-semibold">Members</h2>
      <ul className="flex flex-col gap-1">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between text-sm">
            <span>[{m.member_type}] {m.member_id.slice(0, 8)}</span>
            {m.member_type === "agent" && (
              <Select
                value={m.subscribe_mode ?? "subscribe"}
                onValueChange={(v) =>
                  upsert.mutate({ memberRef: `agent:${m.member_id}`, subscribe_mode: v as any })
                }
              >
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mention_only">Mention only</SelectItem>
                  <SelectItem value="subscribe">Subscribe</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button variant="ghost" size="sm"
              onClick={() => remove.mutate(`${m.member_type}:${m.member_id}`)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {/* "Add agent" button + dialog using listAgents query — defer the picker to a follow-up; for MVP, paste agent id in a small input */}
    </aside>
  );
}
```

Mount it inside `ChannelView` as the right pane (split layout).

- [ ] **Step 2: Manual smoke**

`make dev` → create a channel → open settings → add an agent (workspace must already have one, or seed via `make cli ARGS="agent create ..."`). @ the agent. Verify a streaming message appears.

- [ ] **Step 3: Commit**

```bash
git add packages/views/channels/components/
git commit -m "feat(views): channel settings panel — agent membership + per-agent subscribe_mode"
```

---

### Task C.6 — E2E: @mention triggers agent reply

**Files:**
- Create: `e2e/tests/channels-agent-mention.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from "@playwright/test";
import { signInAndGotoWorkspace, ensureSeedAgent } from "./helpers/auth";

test("@mention an agent gets a streaming reply", async ({ page }) => {
  await signInAndGotoWorkspace(page);
  const agentName = await ensureSeedAgent(page); // creates a stub-claude-code agent if absent

  await page.getByRole("button", { name: "New channel" }).click();
  await page.getByLabel("Name").fill("agent-test");
  await page.getByRole("button", { name: "Create" }).click();

  // Add the agent to this channel.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: `Add agent ${agentName}` }).click();

  await page.getByTestId("channel-composer-textarea").fill(`@${agentName} hi`);
  await page.getByRole("button", { name: "Send" }).click();

  // Wait up to 30s for the agent's streaming reply to land.
  await expect(page.getByTestId("channel-message").last()).toContainText(/.+/, { timeout: 30000 });
});
```

> `ensureSeedAgent` should return a name like `"stub-claude"` and configure the daemon to use a deterministic stub responder. If folio's existing chat e2e doesn't have such a helper, build one — it's a small file that runs `make cli ARGS="agent create ..."` with a deterministic runtime.

- [ ] **Step 2: Run**

```bash
make dev
pnpm exec playwright test e2e/tests/channels-agent-mention.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/channels-agent-mention.spec.ts e2e/tests/helpers/auth.ts
git commit -m "test(e2e): @mention triggers agent streaming reply"
```

---

## Phase D — Subscribe mode + cooldown gate

### Task D.1 — Server: dispatcher subscribe path

**Files:**
- Modify: `server/internal/agent/channel_dispatcher.go` (already wrote subscribe path in C.2 — verify)
- Modify: `server/internal/agent/channel_dispatcher_test.go` (add subscribe tests)

- [ ] **Step 1: Add tests**

```go
func TestDispatch_SubscribeMode_RespectsCooldown(t *testing.T) {
	if testDB == nil { t.Skip() }
	ctx := context.Background()
	ws, ch := seedChannelWithTwoAgents(t)
	setSubscribeMode(t, ch.ID, ws.AgentA.ID, "subscribe")
	setSubscribeMode(t, ch.ID, ws.AgentB.ID, "subscribe")
	setAgentLastReplied(t, ch.ID, ws.AgentA.ID, time.Now().Add(-1*time.Second)) // within 30s cooldown

	msg := insertHumanMessage(t, ch.ID, "hello", nil)
	d := NewChannelDispatcher(testQueries, testTaskQueue)
	_ = d.Dispatch(ctx, msg)

	enqueued := testTaskQueue.Drain()
	if len(enqueued) != 1 || enqueued[0].AgentID != ws.AgentB.ID {
		t.Fatalf("only B should fire; got %#v", enqueued)
	}
}

func TestDispatch_GateLocksAfterMaxTurns(t *testing.T) {
	if testDB == nil { t.Skip() }
	ctx := context.Background()
	ws, ch := seedChannelWithTwoAgents(t)
	setSubscribeMode(t, ch.ID, ws.AgentA.ID, "subscribe")
	setSubscribeMode(t, ch.ID, ws.AgentB.ID, "subscribe")
	setMaxConsecutiveAgentTurns(t, ch.ID, 2)

	d := NewChannelDispatcher(testQueries, testTaskQueue)

	// Human starts the convo
	_ = d.Dispatch(ctx, insertHumanMessage(t, ch.ID, "kick off", nil))
	_ = testTaskQueue.Drain() // both agents enqueued; we don't simulate execution here

	// Agent A "replies"
	_ = d.Dispatch(ctx, insertAgentMessage(t, ch.ID, ws.AgentA.ID, "first"))
	// Agent B "replies"
	_ = d.Dispatch(ctx, insertAgentMessage(t, ch.ID, ws.AgentB.ID, "second"))
	// Now consecutive_agent_turns should equal max — next agent message should NOT enqueue.
	_ = testTaskQueue.Drain()
	_ = d.Dispatch(ctx, insertAgentMessage(t, ch.ID, ws.AgentA.ID, "third"))
	if got := testTaskQueue.Drain(); len(got) != 0 {
		t.Errorf("gate should be closed; got %d enqueues", len(got))
	}

	// Human reopens
	_ = d.Dispatch(ctx, insertHumanMessage(t, ch.ID, "go on", nil))
	if got := testTaskQueue.Drain(); len(got) == 0 {
		t.Error("gate should reopen after human")
	}
}
```

- [ ] **Step 2: Run; verify pass (since C.2 already implemented the path)**

```bash
cd server && go test ./internal/agent/ -run "TestDispatch_SubscribeMode|TestDispatch_GateLocksAfterMaxTurns" -v
```
Expected: PASS. If not, fix the dispatcher to match the test.

- [ ] **Step 3: Commit**

```bash
git add server/internal/agent/channel_dispatcher_test.go server/internal/agent/channel_dispatcher.go
git commit -m "test(agent): subscribe-mode cooldown + consecutive-turn gate"
```

---

### Task D.2 — UI: cooldown / max-turns sliders in settings panel

**Files:**
- Modify: `packages/views/channels/components/channel-settings-panel.tsx`
- Modify: `packages/core/channels/mutations.ts` (add `usePatchChannel`)

- [ ] **Step 1: Add `usePatchChannel`**

```ts
export function usePatchChannel(channelId: string) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string; topic?: string;
      default_subscribe_mode?: SubscribeMode;
      agent_cooldown_ms?: number;
      max_consecutive_agent_turns?: number;
    }) => api.patchChannel(channelId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.detail(wsId, channelId) });
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
    },
  });
}
```

- [ ] **Step 2: Add controls to settings panel**

```tsx
<section className="border-t pt-2 mt-2 flex flex-col gap-2">
  <h3 className="text-sm font-semibold">Agent behavior</h3>
  <Label>Default mode for new agent members</Label>
  <Select
    value={channel.default_subscribe_mode}
    onValueChange={(v) => patch.mutate({ default_subscribe_mode: v as any })}
  >
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="mention_only">Mention only</SelectItem>
      <SelectItem value="subscribe">Subscribe</SelectItem>
    </SelectContent>
  </Select>
  <Label>Cooldown (ms): {channel.agent_cooldown_ms}</Label>
  <Slider
    min={5000} max={120000} step={5000}
    value={[channel.agent_cooldown_ms]}
    onValueChange={([v]) => patch.mutate({ agent_cooldown_ms: v })}
  />
  <Label>Max consecutive agent turns: {channel.max_consecutive_agent_turns}</Label>
  <Slider
    min={1} max={20} step={1}
    value={[channel.max_consecutive_agent_turns]}
    onValueChange={([v]) => patch.mutate({ max_consecutive_agent_turns: v })}
  />
</section>
```

- [ ] **Step 3: Manual test**

`make dev`. Set cooldown to 5000, max-turns to 2, two agents subscribed. Type "hi". Watch the back-and-forth lock at 2 turns. Type something — the gate reopens.

- [ ] **Step 4: Commit**

```bash
git add packages/core/channels/mutations.ts packages/views/channels/components/channel-settings-panel.tsx
git commit -m "feat(views): cooldown + max-turns + default-mode controls in channel settings"
```

---

## Phase E — Threads

### Task E.1 — Thread API + thread roll-up

**Files:**
- Modify: `server/pkg/db/queries/channel.sql`
- Modify: `server/internal/handler/channel_message.go`

- [ ] **Step 1: Queries**

```sql
-- name: ListChannelThreadMessages :many
SELECT * FROM channel_message
WHERE id = $1 OR parent_message_id = $1
ORDER BY created_at ASC;

-- name: BumpThreadRollup :one
WITH agg AS (
    SELECT count(*) AS n,
           max(created_at) AS last_at,
           coalesce(jsonb_agg(DISTINCT jsonb_build_object('type', author_type, 'id', author_id)) FILTER (WHERE author_id IS NOT NULL), '[]'::jsonb) AS parts
    FROM channel_message
    WHERE parent_message_id = $1
)
UPDATE channel_message
SET reply_count = agg.n,
    last_reply_at = agg.last_at,
    reply_participants = agg.parts
FROM agg
WHERE channel_message.id = $1
RETURNING channel_message.*;
```

Run `make sqlc`.

- [ ] **Step 2: Test**

```go
func TestThreadReply_BumpsRollupAndExcludesFromMainList(t *testing.T) {
	if testHandler == nil { t.Skip() }
	c := mustCreateChannel(t, "thread-test", "public")

	parent := postMessage(t, c.ID, "the question", "")
	_ = postMessage(t, c.ID, "reply 1", parent.ID)
	_ = postMessage(t, c.ID, "reply 2", parent.ID)

	// Main timeline excludes thread replies.
	main := listMessages(t, c.ID)
	if len(main) != 1 || main[0].Body != "the question" {
		t.Fatalf("main=%+v", main)
	}

	// Thread fetch returns parent + 2 replies in order.
	thread := getThread(t, c.ID, parent.ID)
	if len(thread) != 3 { t.Fatalf("thread len=%d", len(thread)) }
	if thread[0].Body != "the question" { t.Errorf("first=%v", thread[0].Body) }

	// Parent's roll-up reflects 2 replies.
	if thread[0].ReplyCount != 2 {
		t.Errorf("reply_count=%d", thread[0].ReplyCount)
	}
}
```

- [ ] **Step 3: Implement**

Update `SendChannelMessage` to call `BumpThreadRollup` when `parent_message_id` is set, and publish a `channel.thread.rollup` event.

Add a new handler:

```go
func (h *Handler) GetChannelThread(w http.ResponseWriter, r *http.Request) {
    parentUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "messageID"), "messageID")
    if !ok { return }
    rows, err := h.Queries.ListChannelThreadMessages(r.Context(), pgtype.UUID{Bytes: parentUUID, Valid: true})
    if err != nil { writeError(w, http.StatusInternalServerError, "thread fetch failed"); return }
    _ = json.NewEncoder(w).Encode(rows)
}
```

Mount: `r.Get("/{channelID}/messages/{messageID}/thread", h.GetChannelThread)`.

- [ ] **Step 4: Run; pass**

```bash
cd server && go test ./internal/handler/ -run TestThreadReply -v
```

- [ ] **Step 5: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel_message.go server/internal/handler/handler.go
git commit -m "feat(server): thread support — replies, rollup, dedicated fetch endpoint"
```

---

### Task E.2 — Frontend: thread queries + drawer

**Files:**
- Modify: `packages/core/channels/queries.ts` (add `channelThreadOptions`)
- Modify: `packages/core/api/...` (add `getChannelThread`)
- Create: `packages/views/channels/components/thread-drawer.tsx`
- Modify: `packages/views/channels/components/channel-message.tsx` (add reply count + click-to-open)
- Modify: `packages/views/channels/components/channel-view.tsx` (mount drawer)

- [ ] **Step 1: API + queryOptions**

```ts
// in api client
getChannelThread(channelId: string, messageId: string): Promise<ChannelMessage[]> {
  return this.get(`/channels/${channelId}/messages/${messageId}/thread`);
}

// in queries.ts (key already takes both per Task A.7 — this is a straight call)
export const channelThreadOptions = (channelId: string, parentId: string) =>
  queryOptions({
    queryKey: channelKeys.thread(channelId, parentId),
    queryFn: () => api.getChannelThread(channelId, parentId),
    staleTime: Infinity,
  });
```

- [ ] **Step 2: Drawer component**

```tsx
import { useSuspenseQuery } from "@tanstack/react-query";
import { channelThreadOptions, useChannelClientStore } from "@folio/core/channels";
import { ChannelMessageRow } from "./channel-message";
import { ChannelComposer } from "./channel-composer";

export function ThreadDrawer({ channelId, parentId }: { channelId: string; parentId: string }) {
  const closeThread = useChannelClientStore((s) => s.closeThread);
  const { data: thread } = useSuspenseQuery(channelThreadOptions(channelId, parentId));
  const [parent, ...replies] = thread;
  return (
    <aside data-testid="thread-drawer" className="w-96 border-l flex flex-col">
      <header className="border-b px-3 py-2 flex justify-between items-center">
        <h2 className="font-semibold text-sm">Thread</h2>
        <button onClick={() => closeThread(channelId)} aria-label="Close thread">×</button>
      </header>
      <ul className="flex-1 overflow-y-auto py-1">
        {parent && <ChannelMessageRow msg={parent} />}
        <li className="text-xs text-muted-foreground px-4 py-1 border-t">
          {parent?.reply_count ?? 0} replies
        </li>
        {replies.map((r) => <ChannelMessageRow key={r.id} msg={r} />)}
      </ul>
      <ChannelComposerThread channelId={channelId} parentId={parentId} />
    </aside>
  );
}

function ChannelComposerThread({ channelId, parentId }: { channelId: string; parentId: string }) {
  // identical shape to ChannelComposer but passes parentMessageId on send.
  // Reuse: lift ChannelComposer to accept an optional parentMessageId prop.
}
```

For real reuse, **modify `ChannelComposer`** to accept `parentMessageId?: string` and pass it through to `useSendChannelMessage`. Drop `ChannelComposerThread`.

- [ ] **Step 3: Reply count link in `channel-message.tsx`**

```tsx
{msg.reply_count > 0 && (
  <button
    onClick={() => useChannelClientStore.getState().openThread(msg.channel_id, msg.id)}
    className="text-xs text-primary hover:underline self-start"
  >
    💬 {msg.reply_count} {msg.reply_count === 1 ? "reply" : "replies"}
  </button>
)}
```

- [ ] **Step 4: Mount the drawer in `channel-view.tsx`**

```tsx
const openThreadId = useChannelClientStore((s) => s.openThreadByChannel[channelId]);
return (
  <div className="flex h-full">
    <div className="flex-1 flex flex-col"> {/* main view */} </div>
    {openThreadId && (
      <Suspense fallback={<div className="w-96 border-l p-3 text-muted-foreground">Loading thread…</div>}>
        <ThreadDrawer channelId={channelId} parentId={openThreadId} />
      </Suspense>
    )}
  </div>
);
```

- [ ] **Step 5: E2E test**

`e2e/tests/channels-thread.spec.ts`:

```ts
test("thread: replies show in drawer; main timeline shows reply count", async ({ page }) => {
  await signInAndGotoWorkspace(page);
  // create channel + parent message …
  await page.getByTestId("channel-composer-textarea").fill("the question");
  await page.getByRole("button", { name: "Send" }).click();
  const parent = page.getByTestId("channel-message").last();

  // Reply via API for determinism, or click a "reply in thread" affordance once we add it.
  // For MVP: click the parent's body to focus it, then Shift-R as a hotkey to open thread.
  // (If no hotkey yet, surface a hover toolbar in this same task — see channel-message-actions.)
});
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/channels/ packages/views/channels/components/ e2e/tests/channels-thread.spec.ts
git commit -m "feat(views): threads — drawer, reply-count link, composer accepts parent_message_id"
```

---

### Task E.3 — Dispatcher: thread context restriction

**Files:**
- Modify: `server/internal/agent/channel_dispatcher.go`
- Modify: `server/internal/daemon/.../prompt builder` (already handled in C.3)

- [ ] **Step 1: Verify behavior**

The dispatcher already passes `parent_message_id` into the task context. The prompt builder uses it to restrict history (see C.3). Add an integration test that confirms the wired path:

```go
func TestDispatch_ThreadReply_PassesParentMessageID(t *testing.T) {
	if testDB == nil { t.Skip() }
	_, ch := seedChannelWithTwoAgents(t)
	parent := insertHumanMessage(t, ch.ID, "topic", nil)
	reply := insertHumanMessageWithParent(t, ch.ID, "follow up", parent.ID, nil)

	d := NewChannelDispatcher(testQueries, testTaskQueue)
	_ = d.Dispatch(context.Background(), reply)

	enq := testTaskQueue.Drain()
	if len(enq) == 0 { t.Fatal("expected at least one enqueue") }
	var ctxMap map[string]any
	_ = json.Unmarshal(enq[0].Context, &ctxMap)
	if ctxMap["parent_message_id"] != parent.ID.String() {
		t.Errorf("parent_message_id=%v want %v", ctxMap["parent_message_id"], parent.ID)
	}
}
```

- [ ] **Step 2: Run; should pass**

If it fails, ensure `Dispatch` reads `msg.ParentMessageID` and writes it into the JSON context. (The skeleton in C.2 step 4 already does this.)

- [ ] **Step 3: Commit**

```bash
git add server/internal/agent/channel_dispatcher_test.go
git commit -m "test(agent): dispatcher propagates parent_message_id into thread tasks"
```

---

## Phase F — Reactions

### Task F.1 — Reactions API

**Files:**
- Modify: `server/pkg/db/queries/channel.sql`
- Create: `server/internal/handler/channel_reaction.go` + `_test.go`
- Modify: `server/internal/handler/handler.go`
- Modify: `server/internal/events/channel_events.go`

- [ ] **Step 1: Queries**

```sql
-- name: AddReaction :one
INSERT INTO channel_message_reaction (message_id, reactor_type, reactor_id, emoji)
VALUES ($1, $2, $3, $4)
ON CONFLICT (message_id, reactor_type, reactor_id, emoji) DO NOTHING
RETURNING *;

-- name: RemoveReaction :exec
DELETE FROM channel_message_reaction
WHERE message_id = $1 AND reactor_type = $2 AND reactor_id = $3 AND emoji = $4;

-- name: ListReactionsForMessage :many
SELECT * FROM channel_message_reaction WHERE message_id = $1;
```

Run `make sqlc`.

- [ ] **Step 2: Handler + tests**

```go
type ReactionRequest struct{ Emoji string `json:"emoji"` }

func (h *Handler) AddChannelReaction(w http.ResponseWriter, r *http.Request) {
    userID, ok := requireUserID(w, r); if !ok { return }
    workspaceUUID, ok := parseUUIDOrBadRequest(w, ctxWorkspaceID(r.Context()), "workspace id"); if !ok { return }
    msgUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "messageID"), "messageID"); if !ok { return }
    var req ReactionRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Emoji == "" {
        writeError(w, http.StatusBadRequest, "emoji required"); return
    }
    memberID, err := h.Queries.GetMemberIDForUser(r.Context(), db.GetMemberIDForUserParams{
        WorkspaceID: workspaceUUID, UserID: userID,
    }); if err != nil { writeError(w, http.StatusForbidden, "not a member"); return }

    row, err := h.Queries.AddReaction(r.Context(), db.AddReactionParams{
        MessageID: msgUUID, ReactorType: "member", ReactorID: memberID, Emoji: req.Emoji,
    })
    if err != nil { writeError(w, http.StatusInternalServerError, "add failed"); return }
    h.Bus.Publish(events.ChannelReactionAdded(workspaceUUID.String(), row))
    _ = json.NewEncoder(w).Encode(row)
}

func (h *Handler) RemoveChannelReaction(w http.ResponseWriter, r *http.Request) {
    // mirror Add, then publish KindChannelReactionRemoved
}
```

Tests assert add → list shows it, remove → list empty, duplicate add is idempotent.

- [ ] **Step 3: Mount**

```go
r.Post("/{channelID}/messages/{messageID}/reactions", h.AddChannelReaction)
r.Delete("/{channelID}/messages/{messageID}/reactions", h.RemoveChannelReaction)
```

- [ ] **Step 4: Run; pass**

```bash
cd server && go test ./internal/handler/ -run TestChannelReaction -v
```

- [ ] **Step 5: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ server/internal/handler/channel_reaction.go server/internal/handler/channel_reaction_test.go server/internal/handler/handler.go server/internal/events/channel_events.go
git commit -m "feat(server): channel message reactions"
```

---

### Task F.2 — Reactions UI

**Files:**
- Create: `packages/views/channels/components/reaction-bar.tsx`
- Modify: `packages/views/channels/components/channel-message.tsx` (mount bar)
- Modify: `packages/core/api/...` + `packages/core/channels/mutations.ts`

- [ ] **Step 1: API + mutation**

```ts
// api
addChannelReaction(channelId: string, messageId: string, emoji: string): Promise<ChannelReaction> {
  return this.post(`/channels/${channelId}/messages/${messageId}/reactions`, { emoji });
}
removeChannelReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
  return this.delete(`/channels/${channelId}/messages/${messageId}/reactions`, { emoji });
}

// mutations
export function useToggleReaction(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { messageId: string; emoji: string; on: boolean }) =>
      vars.on
        ? api.addChannelReaction(channelId, vars.messageId, vars.emoji)
        : api.removeChannelReaction(channelId, vars.messageId, vars.emoji),
    onSettled: () => qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) }),
  });
}
```

- [ ] **Step 2: Reaction bar**

```tsx
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useToggleReaction } from "@folio/core/channels";

const QUICK = ["👍","🎉","✅","❤️","😄","🚀"];

export function ReactionBar({
  channelId, messageId, reactions,
}: { channelId: string; messageId: string; reactions: { emoji: string; count: number; mineActive: boolean }[] }) {
  const toggle = useToggleReaction(channelId);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-1 flex-wrap pt-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => toggle.mutate({ messageId, emoji: r.emoji, on: !r.mineActive })}
          className={"text-xs rounded-full border px-2 py-0.5 " + (r.mineActive ? "bg-primary/10 border-primary" : "")}
        >
          {r.emoji} {r.count}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><button className="text-xs rounded-full border px-2 py-0.5">+</button></PopoverTrigger>
        <PopoverContent className="flex gap-1 p-1">
          {QUICK.map((e) => (
            <button key={e} onClick={() => { toggle.mutate({ messageId, emoji: e, on: true }); setOpen(false); }}>
              {e}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

> The aggregation `{ emoji, count, mineActive }` from a flat list of reactions is done in `channel-message.tsx`:
> ```ts
> const grouped = useMemo(() => {
>   const acc = new Map<string, { count: number; mineActive: boolean }>();
>   for (const r of msg.reactions ?? []) {
>     const cur = acc.get(r.emoji) ?? { count: 0, mineActive: false };
>     cur.count++;
>     if (r.reactor_type === "member" && r.reactor_id === currentMemberId) cur.mineActive = true;
>     acc.set(r.emoji, cur);
>   }
>   return [...acc].map(([emoji, v]) => ({ emoji, ...v }));
> }, [msg.reactions, currentMemberId]);
> ```
> This requires server to include `reactions` in the message payload — extend `ListChannelMainMessages` to LEFT JOIN aggregate, or fetch separately and merge in the query layer.

- [ ] **Step 3: Server: include reactions in message list**

Add a SQL aggregation:

```sql
-- name: ListChannelMainMessagesWithReactions :many
SELECT m.*,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('emoji', emoji, 'reactor_type', reactor_type, 'reactor_id', reactor_id))
     FROM channel_message_reaction WHERE message_id = m.id),
    '[]'::jsonb
  ) AS reactions
FROM channel_message m
WHERE m.channel_id = $1 AND m.parent_message_id IS NULL
  AND (sqlc.narg('cursor_created_at')::timestamptz IS NULL OR m.created_at < sqlc.narg('cursor_created_at'))
ORDER BY m.created_at DESC
LIMIT $2;
```

Replace the call site in `ListChannelMessages` handler. Update `ChannelMessage` type with `reactions: Reaction[]`.

- [ ] **Step 4: Commit**

```bash
git add server/pkg/db/queries/channel.sql server/pkg/db/generated/ packages/core/types/channel.ts packages/core/api/ packages/core/channels/mutations.ts packages/views/channels/components/
git commit -m "feat(views): reaction bar + quick picker; server returns reactions inline"
```

---

## Phase G — Polish + i18n

### Task G.1 — i18n entries

**Files:**
- Modify: `packages/views/locales/en.json`
- Modify: `packages/views/locales/zh-CN.json`
- Modify: `apps/docs/content/docs/developers/conventions.mdx` (glossary table)

- [ ] **Step 1: Add glossary entries**

In `conventions.mdx`'s glossary table, append rows:

| EN | zh-CN |
|---|---|
| channel | 频道 |
| topic (channel topic) | 主题 |
| thread | 串 |
| reaction | 表情回应 |
| direct message / DM | 私信 |
| group DM | 群组私信 |
| subscribe (mode) | 订阅 |
| mention only (mode) | 仅提及 |

Same in `conventions.zh.mdx` mirrored.

- [ ] **Step 2: Walk every user-visible string in `packages/views/channels/` and convert to `t("…")`**

Use the existing i18n hook (look for usage in `packages/views/chat/` for the pattern).

- [ ] **Step 3: Add to en.json and zh-CN.json**

Sample keys:

```json
{
  "channels.title": "Channels",
  "channels.new": "New channel",
  "channels.create.name": "Name",
  "channels.create.visibility": "Visibility",
  "channels.kind.public": "Public",
  "channels.kind.private": "Private",
  "channels.composer.placeholder": "Write a message…",
  "channels.composer.send": "Send",
  "channels.empty": "No messages yet. Say hi 👋",
  "channels.thread.title": "Thread",
  "channels.thread.repliesCount_one": "{{count}} reply",
  "channels.thread.repliesCount_other": "{{count}} replies",
  "channels.settings.agentBehavior": "Agent behavior",
  "channels.settings.cooldown": "Cooldown (ms)",
  "channels.settings.maxTurns": "Max consecutive agent turns",
  "channels.settings.defaultMode": "Default mode for new agents"
}
```

zh-CN counterparts.

- [ ] **Step 4: Typecheck + smoke**

```bash
pnpm typecheck
make dev # toggle language switcher; verify all channel screens
```

- [ ] **Step 5: Commit**

```bash
git add packages/views/locales/ packages/views/channels/ apps/docs/content/docs/developers/conventions.mdx apps/docs/content/docs/developers/conventions.zh.mdx
git commit -m "feat(i18n): channels EN + zh-CN strings; glossary entries"
```

---

### Task G.2 — Failure UI + empty/loading states

**Files:**
- Modify: `packages/views/channels/components/channel-message.tsx`
- Modify: `packages/views/channels/components/channel-view.tsx`

- [ ] **Step 1: Failure bubble (already partially in A.9 via `delivery_status === 'failed'` styling — extend)**

In `channel-message.tsx`:

```tsx
{msg.delivery_status === "failed" && (
  <div className="mt-1 text-xs text-destructive">
    {t(`channels.failure.${msg.failure_reason ?? "unknown"}`)}
    <button onClick={() => /* retry mutation, dispatched via existing chat retry pattern */} className="ml-2 underline">
      {t("channels.failure.retry")}
    </button>
  </div>
)}
```

Add the i18n keys for the failure reasons enumerated in the spec (agent_error, connection_error, timeout, unknown).

- [ ] **Step 2: Loading skeleton + offline banner**

For empty state, leverage existing `views/chat/components/no-agent-banner.tsx` pattern: when a channel has zero agent members, show a banner: "Add an agent to enable AI replies in this channel."

For loading: the `<Suspense fallback>` already covers it.

- [ ] **Step 3: Commit**

```bash
git add packages/views/channels/components/
git commit -m "feat(views): channel failure bubble + empty/no-agent banner"
```

---

### Task G.3 — Final golden-path e2e

**Files:**
- Create: `e2e/tests/channels-golden.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from "@playwright/test";
import { signInAndGotoWorkspace, ensureSeedAgent } from "./helpers/auth";

test("golden path: create channel, add agent, @mention, thread reply, react", async ({ page }) => {
  await signInAndGotoWorkspace(page);
  const agent = await ensureSeedAgent(page);

  // Create
  await page.getByRole("button", { name: "New channel" }).click();
  await page.getByLabel("Name").fill("golden");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "# golden" })).toBeVisible();

  // Add agent
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: `Add agent ${agent}` }).click();

  // @mention triggers reply
  await page.getByTestId("channel-composer-textarea").fill(`@${agent} say hello`);
  await page.getByRole("button", { name: "Send" }).click();
  const agentReply = page.getByTestId("channel-message").nth(1); // 2nd message
  await expect(agentReply).toContainText(/.+/, { timeout: 30000 });

  // Open thread on agent reply
  await agentReply.click();
  await page.keyboard.press("Shift+r"); // assuming the hotkey is wired; otherwise click the 💬 link after a manual reply
  await expect(page.getByTestId("thread-drawer")).toBeVisible();

  // React
  await agentReply.hover();
  await page.getByRole("button", { name: "+", exact: true }).first().click();
  await page.getByText("👍").click();
  await expect(agentReply.getByText("👍 1")).toBeVisible();
});
```

- [ ] **Step 2: Run all e2e**

```bash
pnpm exec playwright test e2e/tests/channels-*.spec.ts
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/channels-golden.spec.ts
git commit -m "test(e2e): channels golden path"
```

---

## Final checkpoint

- [ ] Run all unit + integration tests:
  ```bash
  pnpm test && cd server && go test ./...
  ```
- [ ] Run all e2e:
  ```bash
  pnpm exec playwright test e2e/tests/channels-*.spec.ts
  ```
- [ ] Manual full walkthrough of the spec's §9 failure modes (offline mid-stream, gate locking, session expiry).
- [ ] Verify migration round-trip is still clean: `make migrate-down && make migrate-up`.
- [ ] Tag the merge: `git tag feat-channels-mvp`.

---

## Notes for the implementing engineer

- **Follow `CLAUDE.md`**: `packages/core/` cannot import from `next/*` or `react-router-dom`. `packages/views/` cannot import from `apps/web/*` or `next/*`. WS events ALWAYS invalidate queries — never write to Zustand directly. All shared deps go through `pnpm-workspace.yaml` `catalog:`.
- **sqlc workflow:** edit `.sql` files in `server/pkg/db/queries/`, run `make sqlc`, commit both the SQL and the regenerated `server/pkg/db/generated/`.
- **Migrations are append-only** — don't edit a previously merged migration file. If you need to fix something, write a new one.
- **Test fixtures (`testHandler`, `testWorkspace`, `createHandlerTestAgent`, `newAuthedRequest`) live in `server/internal/handler/handler_test.go`.** Read it before writing your first handler test.
- **Optimistic mutations**: roll back on error, invalidate on settle — see how `chat` does this for the canonical pattern.
- **i18n keys** must be added to BOTH `en.json` and `zh-CN.json` in the same commit as the component change.
- **Streaming throttling**: keep `channel.message.patched` at ≤10 Hz per message ID, server-side. Browsers will choke past that.
