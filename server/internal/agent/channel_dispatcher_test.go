package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/airborne23/folio/server/pkg/db/generated"
)

// testPool and testQueries are initialised in TestMain. When the database is
// not reachable they remain nil and every test calls t.Skip.
var testPool *pgxpool.Pool
var testQueries *db.Queries

// fixtureIDs holds the shared workspace / user / runtime IDs seeded once at
// test startup and cleaned up at teardown.
var fixtureWorkspaceID string
var fixtureUserID string
var fixtureMemberID string
var fixtureRuntimeID string

const (
	dispatcherTestEmail         = "dispatcher-test@folio.ai"
	dispatcherTestWorkspaceSlug = "dispatcher-tests"
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://folio:folio@localhost:5432/folio?sslmode=disable"
	}

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		fmt.Printf("Skipping tests: could not connect to database: %v\n", err)
		os.Exit(0)
	}
	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("Skipping tests: database not reachable: %v\n", err)
		pool.Close()
		os.Exit(0)
	}

	testPool = pool
	testQueries = db.New(pool)

	if err := setupFixture(ctx, pool); err != nil {
		fmt.Printf("Failed to set up test fixture: %v\n", err)
		pool.Close()
		os.Exit(1)
	}

	code := m.Run()

	if err := cleanupFixture(context.Background(), pool); err != nil {
		fmt.Printf("Failed to clean up test fixture: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	pool.Close()
	os.Exit(code)
}

func setupFixture(ctx context.Context, pool *pgxpool.Pool) error {
	// Clean up any leftovers from a previous interrupted run.
	if err := cleanupFixture(ctx, pool); err != nil {
		return err
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id
	`, "Dispatcher Test User", dispatcherTestEmail).Scan(&fixtureUserID); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, "Dispatcher Tests", dispatcherTestWorkspaceSlug, "Temp workspace for dispatcher tests", "DIS").Scan(&fixtureWorkspaceID); err != nil {
		return fmt.Errorf("insert workspace: %w", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id
	`, fixtureWorkspaceID, fixtureUserID).Scan(&fixtureMemberID); err != nil {
		return fmt.Errorf("insert member: %w", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at)
		VALUES ($1, NULL, $2, 'cloud', 'dispatcher_test_runtime', 'online', '{}', '{}'::jsonb, now())
		RETURNING id
	`, fixtureWorkspaceID, "Dispatcher Test Runtime").Scan(&fixtureRuntimeID); err != nil {
		return fmt.Errorf("insert runtime: %w", err)
	}

	return nil
}

func cleanupFixture(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, dispatcherTestWorkspaceSlug); err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, `DELETE FROM "user" WHERE email = $1`, dispatcherTestEmail); err != nil {
		return err
	}
	return nil
}

// seedResult holds the IDs for a seeded channel + agent pair.
type seedResult struct {
	ChannelID pgtype.UUID
	AgentID   pgtype.UUID
}

// seedChannelWithAgent creates a public channel and an agent that is a member
// of that channel. The agent has a runtime so enqueue would succeed.
// The channel and agent are cleaned up by t.Cleanup.
func seedChannelWithAgent(t *testing.T) seedResult {
	t.Helper()
	ctx := context.Background()

	var channelID pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO channel (workspace_id, name, kind, default_subscribe_mode, agent_cooldown_ms, max_consecutive_agent_turns)
		VALUES ($1, 'test-chan-' || substr(md5(random()::text), 1, 8), 'public', 'mention_only', 30000, 5) RETURNING id
	`, fixtureWorkspaceID).Scan(&channelID); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel WHERE id = $1`, channelID)
	})

	var agentID pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-agent-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID)
	})

	// Add agent as channel member.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO channel_member (channel_id, member_type, member_id) VALUES ($1, 'agent', $2)
	`, channelID, agentID); err != nil {
		t.Fatalf("seed channel_member: %v", err)
	}

	return seedResult{ChannelID: channelID, AgentID: agentID}
}

// insertHumanMessageWithMentions inserts a channel_message authored by the
// test member with optional mentions payload.
func insertHumanMessageWithMentions(t *testing.T, channelID pgtype.UUID, body string, mentions []channelMention) db.ChannelMessage {
	t.Helper()
	mentionsJSON := []byte("[]")
	if len(mentions) > 0 {
		var err error
		mentionsJSON, err = json.Marshal(mentions)
		if err != nil {
			t.Fatalf("marshal mentions: %v", err)
		}
	}

	// Parse fixtureMemberID to pgtype.UUID.
	var memberID pgtype.UUID
	if err := memberID.Scan(fixtureMemberID); err != nil {
		t.Fatalf("parse member id: %v", err)
	}

	msg, err := testQueries.InsertChannelMessage(context.Background(), db.InsertChannelMessageParams{
		ChannelID:      channelID,
		AuthorType:     "member",
		AuthorID:       memberID,
		Body:           body,
		Mentions:       mentionsJSON,
		DeliveryStatus: "complete",
	})
	if err != nil {
		t.Fatalf("insert human message: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})
	return msg
}

// insertAgentMessageWithMentions inserts a channel_message authored by the
// given agent with optional mentions.
func insertAgentMessageWithMentions(t *testing.T, channelID pgtype.UUID, authorAgentID pgtype.UUID, body string, mentions []channelMention) db.ChannelMessage {
	t.Helper()
	mentionsJSON := []byte("[]")
	if len(mentions) > 0 {
		var err error
		mentionsJSON, err = json.Marshal(mentions)
		if err != nil {
			t.Fatalf("marshal mentions: %v", err)
		}
	}

	msg, err := testQueries.InsertChannelMessage(context.Background(), db.InsertChannelMessageParams{
		ChannelID:      channelID,
		AuthorType:     "agent",
		AuthorID:       authorAgentID,
		Body:           body,
		Mentions:       mentionsJSON,
		DeliveryStatus: "complete",
	})
	if err != nil {
		t.Fatalf("insert agent message: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})
	return msg
}

// setConsecutiveAgentTurns directly writes the counter on the channel row.
func setConsecutiveAgentTurns(t *testing.T, channelID pgtype.UUID, n int) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE channel SET consecutive_agent_turns = $1 WHERE id = $2`, n, channelID,
	); err != nil {
		t.Fatalf("setConsecutiveAgentTurns: %v", err)
	}
}

// getConsecutiveAgentTurns reads the counter directly from the DB.
func getConsecutiveAgentTurns(t *testing.T, channelID pgtype.UUID) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT consecutive_agent_turns FROM channel WHERE id = $1`, channelID,
	).Scan(&n); err != nil {
		t.Fatalf("getConsecutiveAgentTurns: %v", err)
	}
	return n
}

// --- Tests ---

// fakeEnqueuer captures Enqueue calls for assertion without hitting the DB.
type fakeEnqueuer struct {
	calls []EnqueueParams
}

func (f *fakeEnqueuer) Enqueue(_ context.Context, p EnqueueParams) error {
	f.calls = append(f.calls, p)
	return nil
}

func TestDispatch_MentionTriggersHighPriorityEnqueue(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	seed := seedChannelWithAgent(t)

	msg := insertHumanMessageWithMentions(t, seed.ChannelID,
		"@stub-agent please help",
		[]channelMention{{Type: "agent", ID: uuidToString(seed.AgentID)}},
	)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue, got %d", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityHigh {
		t.Errorf("priority=%d want %d", fe.calls[0].Priority, PriorityHigh)
	}
	if uuidToString(fe.calls[0].AgentID) != uuidToString(seed.AgentID) {
		t.Errorf("agent_id mismatch: got %s want %s",
			uuidToString(fe.calls[0].AgentID), uuidToString(seed.AgentID))
	}

	// Verify context payload carries trigger_message_id and channel_id.
	var ctxMap map[string]any
	if err := json.Unmarshal(fe.calls[0].Context, &ctxMap); err != nil {
		t.Fatalf("unmarshal context: %v", err)
	}
	if ctxMap["channel_id"] != uuidToString(seed.ChannelID) {
		t.Errorf("ctx.channel_id=%v want %s", ctxMap["channel_id"], uuidToString(seed.ChannelID))
	}
	if ctxMap["trigger_message_id"] != uuidToString(msg.ID) {
		t.Errorf("ctx.trigger_message_id=%v want %s", ctxMap["trigger_message_id"], uuidToString(msg.ID))
	}
}

func TestDispatch_NoMention_NoEnqueue(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)

	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "hello no agents", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if len(fe.calls) != 0 {
		t.Fatalf("want 0 enqueues, got %d", len(fe.calls))
	}
}

func TestDispatch_AgentSelfReply_NoEnqueue(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)

	// An agent message authored by seed.AgentID that mentions seed.AgentID itself
	// — must not enqueue (no self-reply storm).
	msg := insertAgentMessageWithMentions(t, seed.ChannelID, seed.AgentID, "follow-up",
		[]channelMention{{Type: "agent", ID: uuidToString(seed.AgentID)}},
	)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if len(fe.calls) != 0 {
		t.Fatalf("want 0 enqueues (self-reply guard), got %d", len(fe.calls))
	}
}

func TestDispatch_HumanMessage_ResetsConsecutiveTurns(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)

	// Bump consecutive_agent_turns first.
	setConsecutiveAgentTurns(t, seed.ChannelID, 3)

	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "hi", nil)
	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	n := getConsecutiveAgentTurns(t, seed.ChannelID)
	if n != 0 {
		t.Errorf("counter not reset: got %d, want 0", n)
	}
}

// --- D.1: subscribe-mode path ---

// setChannelMemberSubscribeMode sets the per-agent subscribe_mode override on
// the channel_member row. Pass empty string to clear it (channel default
// applies).
func setChannelMemberSubscribeMode(t *testing.T, channelID, agentID pgtype.UUID, mode string) {
	t.Helper()
	if mode == "" {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE channel_member SET subscribe_mode = NULL
			 WHERE channel_id = $1 AND member_type = 'agent' AND member_id = $2`,
			channelID, agentID,
		); err != nil {
			t.Fatalf("clear subscribe_mode: %v", err)
		}
		return
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE channel_member SET subscribe_mode = $3
		 WHERE channel_id = $1 AND member_type = 'agent' AND member_id = $2`,
		channelID, agentID, mode,
	); err != nil {
		t.Fatalf("set subscribe_mode: %v", err)
	}
}

// setChannelMemberLastRepliedAt sets channel_member.last_replied_at to now
// minus the given offset. Pass a positive offset for "replied N ms ago".
func setChannelMemberLastRepliedAt(t *testing.T, channelID, agentID pgtype.UUID, offsetMs int) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE channel_member SET last_replied_at = now() - ($3::int || ' milliseconds')::interval
		 WHERE channel_id = $1 AND member_type = 'agent' AND member_id = $2`,
		channelID, agentID, offsetMs,
	); err != nil {
		t.Fatalf("set last_replied_at: %v", err)
	}
}

// setChannelGate sets the channel-wide cooldown / max-turns config.
func setChannelGate(t *testing.T, channelID pgtype.UUID, cooldownMs, maxTurns int) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE channel SET agent_cooldown_ms = $2, max_consecutive_agent_turns = $3 WHERE id = $1`,
		channelID, cooldownMs, maxTurns,
	); err != nil {
		t.Fatalf("set channel gate: %v", err)
	}
}

func TestDispatch_Subscribe_NoMention_FiresAtNormalPriority(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")

	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "anyone there?", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue, got %d", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityNormal {
		t.Errorf("priority=%d want %d (NORMAL)", fe.calls[0].Priority, PriorityNormal)
	}
}

// Cooldown applies only when the trigger message is agent-authored. Human
// messages always bypass — a human posting again X seconds after a previous
// @-mention reply must not be silenced by that reply's lingering cooldown.
func TestDispatch_Subscribe_CooldownActive_AgentTrigger_Skips(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	// Channel cooldown is 30000ms (per seedChannelWithAgent). Pretend the
	// agent replied 1s ago — well inside the window.
	setChannelMemberLastRepliedAt(t, seed.ChannelID, seed.AgentID, 1000)

	// Need a *second* agent so we have a non-author target — the original
	// agent would skip via the self-reply guard.
	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})

	// Agent-authored trigger drives the cooldown gate.
	msg := insertAgentMessageWithMentions(t, seed.ChannelID, otherAgent, "ping", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 0 {
		t.Fatalf("cooldown should suppress enqueue on agent trigger, got %d calls", len(fe.calls))
	}
}

func TestDispatch_Subscribe_CooldownElapsed_AgentTrigger_Fires(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	// Cooldown is 30000ms; 60s ago is well past it.
	setChannelMemberLastRepliedAt(t, seed.ChannelID, seed.AgentID, 60_000)

	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})

	msg := insertAgentMessageWithMentions(t, seed.ChannelID, otherAgent, "ping", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue once cooldown elapsed, got %d", len(fe.calls))
	}
}

// Human messages bypass the cooldown gate entirely — the gates exist to
// damp agent ↔ agent loops, not to silence subscribe-mode agents on the
// human's next broadcast just because they answered the previous one.
func TestDispatch_Subscribe_HumanTrigger_BypassesCooldown(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	// Agent replied 1s ago — well inside the cooldown.
	setChannelMemberLastRepliedAt(t, seed.ChannelID, seed.AgentID, 1000)

	// Human-authored trigger MUST bypass the cooldown.
	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "tell another joke", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("human trigger should bypass cooldown, got %d calls", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityNormal {
		t.Errorf("priority=%d want NORMAL (subscribe path)", fe.calls[0].Priority)
	}
}

// Mentions bypass cooldown — proves the gate is per-mode, not global.
func TestDispatch_Mention_BypassesCooldown(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	setChannelMemberLastRepliedAt(t, seed.ChannelID, seed.AgentID, 1000)

	msg := insertHumanMessageWithMentions(t, seed.ChannelID,
		"@stub-agent now",
		[]channelMention{{Type: "agent", ID: uuidToString(seed.AgentID)}},
	)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("mention should bypass cooldown, got %d", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityHigh {
		t.Errorf("priority=%d want %d (HIGH)", fe.calls[0].Priority, PriorityHigh)
	}
}

// When consecutive_agent_turns has hit the cap, a non-mention subscribe-path
// agent must NOT fire — but the mention path should still bypass the gate.
//
// This test runs an *agent*-authored message so the "human resets the gate"
// path doesn't clear the counter before we observe it.
func TestDispatch_Subscribe_GateLocked_AgentTrigger_Skips(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	setChannelGate(t, seed.ChannelID, 0 /* no cooldown */, 5)
	setConsecutiveAgentTurns(t, seed.ChannelID, 5) // == max

	// Need a *second* agent so we have one that isn't the author (self-reply
	// guard would skip the original). Spin up another stub.
	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})
	if _, err := testPool.Exec(ctx,
		`INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode) VALUES ($1, 'agent', $2, 'subscribe')`,
		seed.ChannelID, otherAgent,
	); err != nil {
		t.Fatalf("seed second channel_member: %v", err)
	}

	// Agent-authored trigger: counter is NOT reset, gate stays locked.
	msg := insertAgentMessageWithMentions(t, seed.ChannelID, seed.AgentID, "thinking…", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 0 {
		t.Fatalf("locked gate should suppress subscribe-path enqueues, got %d", len(fe.calls))
	}
}

// A human message resets the gate counter to 0, so a previously locked
// subscribe-path agent fires again on the same dispatch. This is the core of
// "humans always reopen the floor."
func TestDispatch_Subscribe_HumanReopensGate(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")
	setChannelGate(t, seed.ChannelID, 0, 5)
	setConsecutiveAgentTurns(t, seed.ChannelID, 5) // == max, would be locked

	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "humans speak again", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if got := getConsecutiveAgentTurns(t, seed.ChannelID); got != 0 {
		t.Errorf("human should reset counter, got %d", got)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue after gate reopen, got %d", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityNormal {
		t.Errorf("subscribe path should be NORMAL, got %d", fe.calls[0].Priority)
	}
}

// E.3 — when a human posts a thread reply that @mentions an agent, the
// dispatcher must propagate parent_message_id into the task context so the
// daemon can build a thread-scoped prompt instead of falling back to the
// main-timeline history.
func TestDispatch_Mention_ThreadReply_PropagatesParent(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)

	// Seed a parent message in the channel.
	parent := insertHumanMessageWithMentions(t, seed.ChannelID, "parent in thread", nil)

	// Insert a thread reply that mentions the agent. We can't use
	// insertHumanMessageWithMentions here because it always inserts a
	// top-level message — the dispatcher cares about the *trigger* row
	// having parent_message_id set, so insert directly.
	mentionsJSON, err := json.Marshal([]channelMention{
		{Type: "agent", ID: uuidToString(seed.AgentID)},
	})
	if err != nil {
		t.Fatalf("marshal mentions: %v", err)
	}
	var memberID pgtype.UUID
	if err := memberID.Scan(fixtureMemberID); err != nil {
		t.Fatalf("parse member id: %v", err)
	}
	reply, err := testQueries.InsertChannelMessage(ctx, db.InsertChannelMessageParams{
		ChannelID:       seed.ChannelID,
		AuthorType:      "member",
		AuthorID:        memberID,
		Body:            "@stub-agent in this thread please",
		ParentMessageID: parent.ID,
		Mentions:        mentionsJSON,
		DeliveryStatus:  "complete",
	})
	if err != nil {
		t.Fatalf("insert thread reply: %v", err)
	}

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, reply); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue, got %d", len(fe.calls))
	}

	var ctxMap map[string]any
	if err := json.Unmarshal(fe.calls[0].Context, &ctxMap); err != nil {
		t.Fatalf("unmarshal task context: %v", err)
	}
	got, ok := ctxMap["parent_message_id"].(string)
	if !ok {
		t.Fatalf("parent_message_id missing or not string: %v", ctxMap["parent_message_id"])
	}
	if got != uuidToString(parent.ID) {
		t.Errorf("parent_message_id=%s want %s", got, uuidToString(parent.ID))
	}
	// trigger_message_id is the reply itself (the message that fired the
	// dispatch), not the parent — different field, different value.
	if trigger := ctxMap["trigger_message_id"]; trigger != uuidToString(reply.ID) {
		t.Errorf("trigger_message_id=%v want %s", trigger, uuidToString(reply.ID))
	}
}

// When an explicit @-mention names a specific agent, other subscribe-mode
// agents in the channel stay silent. Without this rule every subscribe-mode
// agent fires on every directed @-mention and produces "not addressed to
// me" replies, which is noise. Slack-style: mention is directed; subscribe
// is the broadcast tier.
func TestDispatch_Subscribe_AgentNotMentioned_SuppressedWhenSomeoneElseMentioned(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")

	// Add a second agent under the same channel, also subscribe-mode.
	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})
	if _, err := testPool.Exec(ctx,
		`INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode) VALUES ($1, 'agent', $2, 'subscribe')`,
		seed.ChannelID, otherAgent,
	); err != nil {
		t.Fatalf("seed second channel_member: %v", err)
	}

	// Message mentions ONLY otherAgent — seed.AgentID is subscribe-mode but
	// not named. seed.AgentID must NOT fire.
	msg := insertHumanMessageWithMentions(t, seed.ChannelID,
		"@stub-other please help",
		[]channelMention{{Type: "agent", ID: uuidToString(otherAgent)}},
	)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}

	// Only otherAgent should be enqueued. seed.AgentID was suppressed by
	// the mention-suppression rule.
	if len(fe.calls) != 1 {
		t.Fatalf("want 1 enqueue (only the mentioned agent), got %d", len(fe.calls))
	}
	if uuidToString(fe.calls[0].AgentID) != uuidToString(otherAgent) {
		t.Errorf("wrong agent fired: got %s want %s",
			uuidToString(fe.calls[0].AgentID), uuidToString(otherAgent))
	}
	if fe.calls[0].Priority != PriorityHigh {
		t.Errorf("mentioned agent should fire HIGH, got %d", fe.calls[0].Priority)
	}
}

// Member-only @-mention must also suppress subscribe-mode agents — the
// directed-call-out semantic is the same whether the named entity is a
// human or an agent. Before this case was covered, "@some-human 你是谁"
// would fan out to every subscribe agent in the channel.
func TestDispatch_Subscribe_MemberMention_SuppressesAgents(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")

	// Message names a workspace member (the test fixture member), not the
	// agent. The dispatcher must NOT fire seed.AgentID despite subscribe
	// mode being on.
	msg := insertHumanMessageWithMentions(t, seed.ChannelID,
		"@e2e-user 你是谁",
		[]channelMention{{Type: "member", ID: fixtureMemberID}},
	)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 0 {
		t.Fatalf("member @ must not fan out to subscribe agents, got %d enqueues",
			len(fe.calls))
	}
}

// Even when the @-token doesn't resolve to anyone (typo, multi-word name
// the regex stopped on, deleted member), the typed @ still signals
// directed intent. Subscribe-mode agents must not fan out on it.
// Reproducer: "@E2E User 你是谁啊" — token captures "@E2E", DB has no
// user named just "E2E", resolved mentions array is empty, but the user
// clearly wanted to address that member.
func TestDispatch_Subscribe_UnresolvedMention_StillSuppresses(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")

	// Body has an @-token that won't match any agent or member name.
	// `mentions` JSON is the empty array because nothing resolved.
	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "@nobody hi", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 0 {
		t.Fatalf("typed @ must suppress subscribe agents even when unresolved, got %d enqueues",
			len(fe.calls))
	}
}

// When the user's last message is directed at a specific agent, the
// re-dispatch path that fires on the named agent's reply must NOT pull
// other subscribe agents into the chain. The agent's reply has no @ in
// its body, but the conversation's directedness comes from the *user's*
// most recent message — that's what the dispatcher now anchors on.
//
// Reproducer: "@A hi" → A replies "Hi, I'm here." → without anchoring,
// re-dispatch sees no @ in A's reply and fans out to subscribe-mode B,
// which then posts "this isn't addressed to me" — exactly the user
// complaint we're fixing here.
func TestDispatch_Subscribe_AgentReply_AnchorsToLastUserMessage(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelMemberSubscribeMode(t, seed.ChannelID, seed.AgentID, "subscribe")

	// Add a second subscribe agent — this is the one that previously
	// chimed in incorrectly.
	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})
	if _, err := testPool.Exec(ctx,
		`INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode) VALUES ($1, 'agent', $2, 'subscribe')`,
		seed.ChannelID, otherAgent,
	); err != nil {
		t.Fatalf("seed second channel_member: %v", err)
	}

	// User asks @ seed.AgentID specifically — this is the *anchor* for
	// any subsequent agent-reply re-dispatches in this thread.
	insertHumanMessageWithMentions(t, seed.ChannelID,
		"@stub-agent hi",
		[]channelMention{{Type: "agent", ID: uuidToString(seed.AgentID)}},
	)

	// Now seed.AgentID has replied (no @ in its body) and the
	// dispatcher fires on that agent message — emulating my recent
	// re-dispatch-on-agent-reply path.
	agentReply := insertAgentMessageWithMentions(t, seed.ChannelID, seed.AgentID, "Hi, I'm here.", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, agentReply); err != nil {
		t.Fatal(err)
	}

	// Neither the original mentioned agent (self-reply guard) nor the
	// other subscribe agent should fire. Without the anchor fix,
	// otherAgent would have been enqueued and posted "not addressed to
	// me".
	if len(fe.calls) != 0 {
		t.Fatalf("directed chain must not pull in non-mentioned subscribers, got %d enqueues",
			len(fe.calls))
	}
}

// Mentioned agents on the agent-reply re-dispatch path MUST still respect
// the channel-wide consecutive_agent_turns cap. Without this, "@A @B 你
//俩聊" loops forever — re-dispatch on every reply re-fires the other
// mentioned agent at HIGH priority, and HIGH used to bypass all gates.
// Live repro had counter at 9 with max=5 still running.
func TestDispatch_MentionedAgent_ReDispatch_RespectsMaxTurnsCap(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	setChannelGate(t, seed.ChannelID, 0 /* no cooldown */, 5)
	setConsecutiveAgentTurns(t, seed.ChannelID, 5) // already at the cap

	// Need a second agent and a prior member message that names BOTH
	// agents so re-dispatch sees both as "mentioned".
	var otherAgent pgtype.UUID
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'stub-other-' || substr(md5(random()::text), 1, 6), '', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3)
		RETURNING id
	`, fixtureWorkspaceID, fixtureRuntimeID, fixtureUserID).Scan(&otherAgent); err != nil {
		t.Fatalf("seed second agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, otherAgent)
	})

	// Prior member message names BOTH agents — that's the anchor.
	insertHumanMessageWithMentions(t, seed.ChannelID,
		"@stub-agent @stub-other 你俩聊会天",
		[]channelMention{
			{Type: "agent", ID: uuidToString(seed.AgentID)},
			{Type: "agent", ID: uuidToString(otherAgent)},
		},
	)

	// Counter is at the cap. Now seed.AgentID's reply triggers
	// re-dispatch — the other mentioned agent (otherAgent) must NOT
	// fire because the channel turn budget is exhausted.
	agentReply := insertAgentMessageWithMentions(t, seed.ChannelID, seed.AgentID, "ok", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, agentReply); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 0 {
		t.Fatalf("max-turns cap must apply to mentioned agents on re-dispatch, got %d enqueues",
			len(fe.calls))
	}
}

// Channel-level default applies when the per-agent override is NULL.
func TestDispatch_Subscribe_DefaultModeFromChannel(t *testing.T) {
	if testQueries == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seed := seedChannelWithAgent(t)
	// Per-agent subscribe_mode stays NULL (the seed leaves it that way).
	// Flip the channel default to "subscribe" so the agent inherits it.
	if _, err := testPool.Exec(ctx,
		`UPDATE channel SET default_subscribe_mode = 'subscribe' WHERE id = $1`,
		seed.ChannelID,
	); err != nil {
		t.Fatalf("update default_subscribe_mode: %v", err)
	}

	msg := insertHumanMessageWithMentions(t, seed.ChannelID, "hi all", nil)

	fe := &fakeEnqueuer{}
	d := NewChannelDispatcher(testQueries, fe)
	if err := d.Dispatch(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if len(fe.calls) != 1 {
		t.Fatalf("default mode should let agent fire, got %d calls", len(fe.calls))
	}
	if fe.calls[0].Priority != PriorityNormal {
		t.Errorf("priority=%d want NORMAL", fe.calls[0].Priority)
	}
}
