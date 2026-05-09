package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/airborne23/folio/server/internal/events"
	db "github.com/airborne23/folio/server/pkg/db/generated"
)

// cleanupChannel registers a t.Cleanup hook that deletes the row by ID.
// Tests that successfully create a channel must call this so a subsequent
// `go test` run doesn't trip the unique index on (workspace_id, lower(name)).
func cleanupChannel(t *testing.T, id string) {
	t.Helper()
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel WHERE id = $1`, parseUUID(id))
	})
}

func TestCreateChannel_Public(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"name": "general", "kind": "public", "topic": "Random chat"}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	id, _ := got["id"].(string)
	if id == "" {
		t.Fatal("id missing in response")
	}
	cleanupChannel(t, id)

	if got["name"] != "general" {
		t.Errorf("name=%v", got["name"])
	}
	if got["kind"] != "public" {
		t.Errorf("kind=%v", got["kind"])
	}
	if got["default_subscribe_mode"] != "subscribe" {
		t.Errorf("default_subscribe_mode=%v", got["default_subscribe_mode"])
	}
	if got["topic"] != "Random chat" {
		t.Errorf("topic=%v", got["topic"])
	}
	if cd, _ := got["agent_cooldown_ms"].(float64); cd != 30000 {
		t.Errorf("agent_cooldown_ms=%v", got["agent_cooldown_ms"])
	}
	if wsID, _ := got["workspace_id"].(string); wsID != testWorkspaceID {
		t.Errorf("workspace_id=%v want %s", got["workspace_id"], testWorkspaceID)
	}
	if got["creator_member_id"] == nil {
		t.Error("creator_member_id should be populated from the calling member")
	}
}

func TestCreateChannel_GroupDMWithoutName(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "group_dm"}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if id, _ := got["id"].(string); id != "" {
		cleanupChannel(t, id)
	}
}

func TestCreateChannel_PublicWithoutName_Rejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "public"}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_EmptyName_Rejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "public", "name": "   "}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for whitespace-only name, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_GroupDMWithName_Rejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "group_dm", "name": "should-not-have-a-name"}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_GroupDMWithEmptyStringName_Rejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "group_dm", "name": ""}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for explicit empty-string name on group_dm, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_BadKind_Rejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	body := map[string]any{"kind": "broadcast", "name": "foo"}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateChannel_DuplicateName_409(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	first := map[string]any{"name": "duplicate-target", "kind": "public"}
	req1 := newRequest(http.MethodPost, "/api/channels", first)
	rr1 := httptest.NewRecorder()
	testHandler.CreateChannel(rr1, req1)
	if rr1.Code != http.StatusCreated {
		t.Fatalf("seed: %d %s", rr1.Code, rr1.Body.String())
	}
	var firstResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&firstResp)
	if id, _ := firstResp["id"].(string); id != "" {
		cleanupChannel(t, id)
	}

	dup := map[string]any{"name": "duplicate-target", "kind": "public"}
	req2 := newRequest(http.MethodPost, "/api/channels", dup)
	rr2 := httptest.NewRecorder()
	testHandler.CreateChannel(rr2, req2)
	if rr2.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rr2.Code, rr2.Body.String())
	}
}

// mustCreateChannel creates a channel for the current test user and returns the
// decoded response map (which contains "id"). It also registers a cleanup hook.
func mustCreateChannel(t *testing.T, name, kind string) map[string]any {
	t.Helper()
	body := map[string]any{"kind": kind}
	if kind != "group_dm" {
		body["name"] = name
	}
	req := newRequest(http.MethodPost, "/api/channels", body)
	rr := httptest.NewRecorder()
	testHandler.CreateChannel(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed channel %q failed: %d %s", name, rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if id, _ := got["id"].(string); id != "" {
		cleanupChannel(t, id)
	}
	return got
}

func TestListChannels_PublicVisible(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	mustCreateChannel(t, "list-public-1", "public")
	req := newRequest(http.MethodGet, "/api/channels", nil)
	rr := httptest.NewRecorder()
	testHandler.ListChannels(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got []map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	found := false
	for _, c := range got {
		if c["name"] == "list-public-1" {
			found = true
			break
		}
	}
	if !found {
		t.Error("list-public-1 missing from list")
	}
}

func TestGetChannel_FoundAndNotFound(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "get-test", "public")
	id := c["id"].(string)

	// Hit
	req := withURLParam(newRequest(http.MethodGet, "/api/channels/"+id, nil), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.GetChannel(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("hit: %d %s", rr.Code, rr.Body.String())
	}

	// Miss (random UUID)
	missingID := "00000000-0000-0000-0000-000000000000"
	req2 := withURLParam(newRequest(http.MethodGet, "/api/channels/"+missingID, nil), "channelID", missingID)
	rr2 := httptest.NewRecorder()
	testHandler.GetChannel(rr2, req2)
	if rr2.Code != http.StatusNotFound {
		t.Fatalf("miss: %d", rr2.Code)
	}

	// Bad UUID
	req3 := withURLParam(newRequest(http.MethodGet, "/api/channels/not-a-uuid", nil), "channelID", "not-a-uuid")
	rr3 := httptest.NewRecorder()
	testHandler.GetChannel(rr3, req3)
	if rr3.Code != http.StatusBadRequest {
		t.Fatalf("bad uuid: %d", rr3.Code)
	}
}

func TestPatchChannel_OnlyRequestedFieldsChange(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "patch-isolation", "public")
	id := c["id"].(string)

	// PATCH only `topic` — every other field should be untouched.
	body := map[string]any{"topic": "only the topic"}
	req := withURLParam(newRequest(http.MethodPatch, "/api/channels/"+id, body), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.PatchChannel(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got["topic"] != "only the topic" {
		t.Errorf("topic=%v", got["topic"])
	}
	if got["name"] != "patch-isolation" {
		t.Errorf("name mutated: %v", got["name"])
	}
	if got["default_subscribe_mode"] != "subscribe" {
		t.Errorf("default_subscribe_mode mutated: %v", got["default_subscribe_mode"])
	}
	if cd, _ := got["agent_cooldown_ms"].(float64); cd != 30000 {
		t.Errorf("agent_cooldown_ms mutated: %v", got["agent_cooldown_ms"])
	}
	if mt, _ := got["max_consecutive_agent_turns"].(float64); mt != 5 {
		t.Errorf("max_consecutive_agent_turns mutated: %v", got["max_consecutive_agent_turns"])
	}
}

func TestPatchChannel_RenameAndTopic(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "rename-me", "public")
	id := c["id"].(string)

	body := map[string]any{"name": "renamed", "topic": "now with a topic"}
	req := withURLParam(newRequest(http.MethodPatch, "/api/channels/"+id, body), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.PatchChannel(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d %s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got["name"] != "renamed" {
		t.Errorf("name=%v", got["name"])
	}
	if got["topic"] != "now with a topic" {
		t.Errorf("topic=%v", got["topic"])
	}
}

func TestPatchChannel_GroupDMRenameRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "", "group_dm")
	id := c["id"].(string)

	body := map[string]any{"name": "should-not-rename"}
	req := withURLParam(newRequest(http.MethodPatch, "/api/channels/"+id, body), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.PatchChannel(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", rr.Code)
	}
}

func TestArchiveChannel_HappyAndDouble(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "archive-me", "public")
	id := c["id"].(string)

	// First archive: 204
	req := withURLParam(newRequest(http.MethodDelete, "/api/channels/"+id, nil), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.ArchiveChannel(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("first archive: %d %s", rr.Code, rr.Body.String())
	}

	// Second archive: 404 (already archived)
	req2 := withURLParam(newRequest(http.MethodDelete, "/api/channels/"+id, nil), "channelID", id)
	rr2 := httptest.NewRecorder()
	testHandler.ArchiveChannel(rr2, req2)
	if rr2.Code != http.StatusNotFound {
		t.Fatalf("double archive: %d", rr2.Code)
	}
}

// mustSeedSecondMember creates a second user+member in the test workspace and
// registers t.Cleanup to remove the rows. Returns the member ID string.
func mustSeedSecondMember(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	email := fmt.Sprintf("a5-seed-%d@x.com", time.Now().UnixNano())
	var userID string
	if err := testPool.QueryRow(ctx,
		`INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id::text`,
		"a5-seed", email,
	).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	var memberID string
	if err := testPool.QueryRow(ctx,
		`INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id::text`,
		parseUUID(testWorkspaceID), parseUUID(userID),
	).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel_member WHERE member_type = 'member' AND member_id = $1`, parseUUID(memberID))
		testPool.Exec(ctx, `DELETE FROM member WHERE id = $1`, parseUUID(memberID))
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, parseUUID(userID))
	})
	return memberID
}

func TestChannelMember_AddListRemove(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "members-test", "private")
	channelID := c["id"].(string)
	otherMemberID := mustSeedSecondMember(t)

	// Add via PUT
	memberRef := "member:" + otherMemberID
	addReq := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{}),
		"channelID", channelID, "memberRef", memberRef,
	)
	addRR := httptest.NewRecorder()
	testHandler.PutChannelMember(addRR, addReq)
	if addRR.Code != http.StatusOK {
		t.Fatalf("add: %d %s", addRR.Code, addRR.Body.String())
	}

	// List
	listReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+channelID+"/members", nil), "channelID", channelID)
	listRR := httptest.NewRecorder()
	testHandler.ListChannelMembers(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list: %d", listRR.Code)
	}
	var members []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&members)
	// Expect 2 rows: the auto-added creator + the explicitly added otherMember.
	foundOther := false
	for _, m := range members {
		if m["member_id"] == otherMemberID {
			foundOther = true
		}
	}
	if !foundOther {
		t.Fatalf("otherMember not in list: %+v", members)
	}
	if len(members) != 2 {
		t.Fatalf("expected 2 members (creator + other), got %d: %+v", len(members), members)
	}

	// Idempotent re-add (PUT)
	idemRR := httptest.NewRecorder()
	idemReq := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{"subscribe_mode": "mention_only"}),
		"channelID", channelID, "memberRef", memberRef,
	)
	testHandler.PutChannelMember(idemRR, idemReq)
	if idemRR.Code != http.StatusOK {
		t.Fatalf("idempotent re-put: %d %s", idemRR.Code, idemRR.Body.String())
	}
	// Verify subscribe_mode update on conflict
	listReq2 := withURLParam(newRequest(http.MethodGet, "/api/channels/"+channelID+"/members", nil), "channelID", channelID)
	listRR2 := httptest.NewRecorder()
	testHandler.ListChannelMembers(listRR2, listReq2)
	var members2 []map[string]any
	_ = json.NewDecoder(listRR2.Body).Decode(&members2)
	// Still 2 rows (creator + other); find other and verify its subscribe_mode update stuck.
	if len(members2) != 2 {
		t.Fatalf("after re-put expected 2 rows (creator + other), got %d", len(members2))
	}
	var otherRow map[string]any
	for _, m := range members2 {
		if m["member_id"] == otherMemberID {
			otherRow = m
		}
	}
	if otherRow == nil {
		t.Fatal("otherMember missing after re-put")
	}
	if otherRow["subscribe_mode"] != "mention_only" {
		t.Errorf("subscribe_mode update lost: %v", otherRow["subscribe_mode"])
	}

	// Remove
	delReq := withURLParams(
		newRequest(http.MethodDelete, "/api/channels/"+channelID+"/members/"+memberRef, nil),
		"channelID", channelID, "memberRef", memberRef,
	)
	delRR := httptest.NewRecorder()
	testHandler.DeleteChannelMember(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("remove: %d", delRR.Code)
	}

	// Confirm row is gone via list.
	postDelReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+channelID+"/members", nil), "channelID", channelID)
	postDelRR := httptest.NewRecorder()
	testHandler.ListChannelMembers(postDelRR, postDelReq)
	var afterDel []map[string]any
	_ = json.NewDecoder(postDelRR.Body).Decode(&afterDel)
	// Creator stays; other is gone.
	if len(afterDel) != 1 {
		t.Errorf("after remove expected 1 row (creator), got %d (%+v)", len(afterDel), afterDel)
	}
	for _, m := range afterDel {
		if m["member_id"] == otherMemberID {
			t.Errorf("otherMember still in list after remove")
		}
	}

	// Idempotent re-delete
	delRR2 := httptest.NewRecorder()
	delReq2 := withURLParams(
		newRequest(http.MethodDelete, "/api/channels/"+channelID+"/members/"+memberRef, nil),
		"channelID", channelID, "memberRef", memberRef,
	)
	testHandler.DeleteChannelMember(delRR2, delReq2)
	if delRR2.Code != http.StatusNoContent {
		t.Fatalf("idempotent re-delete: %d", delRR2.Code)
	}
}

func TestPutChannelMember_SubscribeModePreservedOnReAddWithoutBody(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "submode-preserve", "private")
	channelID := c["id"].(string)
	otherMemberID := mustSeedSecondMember(t)
	memberRef := "member:" + otherMemberID

	// Set subscribe_mode = mention_only.
	req1 := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{"subscribe_mode": "mention_only"}),
		"channelID", channelID, "memberRef", memberRef,
	)
	rr1 := httptest.NewRecorder()
	testHandler.PutChannelMember(rr1, req1)
	if rr1.Code != http.StatusOK {
		t.Fatalf("initial put: %d %s", rr1.Code, rr1.Body.String())
	}

	// Re-PUT with empty body — must NOT clobber subscribe_mode to NULL.
	req2 := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{}),
		"channelID", channelID, "memberRef", memberRef,
	)
	rr2 := httptest.NewRecorder()
	testHandler.PutChannelMember(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("re-put empty body: %d %s", rr2.Code, rr2.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr2.Body).Decode(&got)
	if got["subscribe_mode"] != "mention_only" {
		t.Errorf("subscribe_mode lost on no-body re-put: %v", got["subscribe_mode"])
	}
}

func TestPutChannelMember_CrossWorkspaceMemberRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "xws-rejection", "private")
	channelID := c["id"].(string)

	// Seed a user + member in a DIFFERENT workspace.
	ctx := context.Background()
	email := fmt.Sprintf("a5-xws-%d@x.com", time.Now().UnixNano())
	var foreignUserID string
	if err := testPool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id::text`, "xws-seed", email).Scan(&foreignUserID); err != nil {
		t.Fatal(err)
	}
	var foreignWorkspaceID string
	if err := testPool.QueryRow(ctx, `INSERT INTO workspace (name, slug) VALUES ($1, $2) RETURNING id::text`, "xws-ws", fmt.Sprintf("xws-%d", time.Now().UnixNano())).Scan(&foreignWorkspaceID); err != nil {
		t.Fatal(err)
	}
	var foreignMemberID string
	if err := testPool.QueryRow(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id::text`, parseUUID(foreignWorkspaceID), parseUUID(foreignUserID)).Scan(&foreignMemberID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, parseUUID(foreignWorkspaceID))
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, parseUUID(foreignUserID))
	})

	memberRef := "member:" + foreignMemberID
	req := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{}),
		"channelID", channelID, "memberRef", memberRef,
	)
	rr := httptest.NewRecorder()
	testHandler.PutChannelMember(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for cross-workspace member, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestPutChannelMember_AgentRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "agent-rejection", "private")
	channelID := c["id"].(string)
	bogusAgentID := "00000000-0000-0000-0000-000000000000"
	memberRef := "agent:" + bogusAgentID
	req := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{}),
		"channelID", channelID, "memberRef", memberRef,
	)
	rr := httptest.NewRecorder()
	testHandler.PutChannelMember(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestPutChannelMember_MalformedRef(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "malformed-ref", "private")
	channelID := c["id"].(string)
	for _, bad := range []string{"foo", "member:", ":x", "owner:abc-uuid"} {
		req := withURLParams(
			newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+bad, map[string]any{}),
			"channelID", channelID, "memberRef", bad,
		)
		rr := httptest.NewRecorder()
		testHandler.PutChannelMember(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("ref=%q expected 400, got %d", bad, rr.Code)
		}
	}
}

func TestSendChannelMessage_Public(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "msg-pub", "public")
	id := c["id"].(string)

	body := map[string]any{"body": "hello channel"}
	req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+id+"/messages", body), "channelID", id)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got["body"] != "hello channel" {
		t.Errorf("body=%v", got["body"])
	}
	if got["author_type"] != "member" {
		t.Errorf("author_type=%v", got["author_type"])
	}
	if got["channel_id"] != id {
		t.Errorf("channel_id=%v want %s", got["channel_id"], id)
	}
	if got["delivery_status"] != "complete" {
		t.Errorf("delivery_status=%v", got["delivery_status"])
	}
	if got["parent_message_id"] != nil {
		t.Errorf("parent_message_id should be nil for top-level: %v", got["parent_message_id"])
	}
}

func TestSendChannelMessage_RejectsEmpty(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "msg-empty", "public")
	id := c["id"].(string)

	for _, bad := range []map[string]any{
		{"body": ""},
		{"body": "   "},
		{},
	} {
		req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+id+"/messages", bad), "channelID", id)
		rr := httptest.NewRecorder()
		testHandler.SendChannelMessage(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("body=%v expected 400, got %d", bad, rr.Code)
		}
	}
}

func TestSendChannelMessage_PrivateNonMemberRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	// Seed a private channel via a DIFFERENT user so testUserID is NOT the creator
	// (and therefore not auto-added to channel_member). Easiest path: insert a
	// channel row directly with a different creator member.
	ctx := context.Background()
	otherUserEmail := fmt.Sprintf("a6-other-%d@x.com", time.Now().UnixNano())
	var otherUserID, otherMemberID, channelID string
	if err := testPool.QueryRow(ctx, `INSERT INTO "user"(name, email) VALUES('a6-other', $1) RETURNING id::text`, otherUserEmail).Scan(&otherUserID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO member(workspace_id, user_id, role) VALUES($1, $2, 'member') RETURNING id::text`, parseUUID(testWorkspaceID), parseUUID(otherUserID)).Scan(&otherMemberID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO channel(workspace_id, name, kind, creator_member_id) VALUES($1, 'a6-private-no-access', 'private', $2) RETURNING id::text`, parseUUID(testWorkspaceID), parseUUID(otherMemberID)).Scan(&channelID); err != nil {
		t.Fatal(err)
	}
	// Make the OTHER user a channel_member (so the channel has at least one), but NOT testUserID.
	if _, err := testPool.Exec(ctx, `INSERT INTO channel_member(channel_id, member_type, member_id) VALUES($1, 'member', $2)`, parseUUID(channelID), parseUUID(otherMemberID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel WHERE id = $1`, parseUUID(channelID))
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, parseUUID(otherUserID))
	})

	body := map[string]any{"body": "should not land"}
	req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages", body), "channelID", channelID)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 (existence-non-leak), got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestListChannelMessages_OrderDescAndCursor(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "msg-list", "public")
	id := c["id"].(string)

	// Seed 3 messages with distinct timestamps. The API returns RFC3339 (seconds
	// precision) so we sleep >1s between inserts to guarantee distinct cursors.
	for _, txt := range []string{"first", "second", "third"} {
		req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+id+"/messages", map[string]any{"body": txt}), "channelID", id)
		rr := httptest.NewRecorder()
		testHandler.SendChannelMessage(rr, req)
		if rr.Code != http.StatusCreated {
			t.Fatalf("seed %q: %d %s", txt, rr.Code, rr.Body.String())
		}
		// Sleep >1s so created_at rounds to a distinct second in the RFC3339 cursor.
		time.Sleep(1100 * time.Millisecond)
	}

	// First page (no cursor): newest 2.
	listReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+id+"/messages?limit=2", nil), "channelID", id)
	listRR := httptest.NewRecorder()
	testHandler.ListChannelMessages(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list: %d", listRR.Code)
	}
	var page1 []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&page1)
	if len(page1) != 2 {
		t.Fatalf("page1 len=%d", len(page1))
	}
	if page1[0]["body"] != "third" {
		t.Errorf("page1[0]=%v", page1[0]["body"])
	}
	if page1[1]["body"] != "second" {
		t.Errorf("page1[1]=%v", page1[1]["body"])
	}

	// Second page using cursor = page1[1].created_at: should return "first".
	// URL-encode the cursor so '+' in timezone offsets is not decoded as a space.
	cursor := url.QueryEscape(page1[1]["created_at"].(string))
	listReq2 := withURLParam(newRequest(http.MethodGet, "/api/channels/"+id+"/messages?limit=2&cursor="+cursor, nil), "channelID", id)
	listRR2 := httptest.NewRecorder()
	testHandler.ListChannelMessages(listRR2, listReq2)
	var page2 []map[string]any
	_ = json.NewDecoder(listRR2.Body).Decode(&page2)
	if len(page2) != 1 || page2[0]["body"] != "first" {
		t.Fatalf("page2: %+v", page2)
	}
}

func TestListChannelMessages_ExcludesThreadReplies(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "msg-thread", "public")
	id := c["id"].(string)

	// Send parent.
	parentReq := withURLParam(newRequest(http.MethodPost, "/api/channels/"+id+"/messages", map[string]any{"body": "parent"}), "channelID", id)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	if parentRR.Code != http.StatusCreated {
		t.Fatalf("seed parent: %d", parentRR.Code)
	}
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	// Send reply with parent_message_id.
	replyReq := withURLParam(newRequest(http.MethodPost, "/api/channels/"+id+"/messages", map[string]any{"body": "reply", "parent_message_id": parentID}), "channelID", id)
	replyRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(replyRR, replyReq)
	if replyRR.Code != http.StatusCreated {
		t.Fatalf("seed reply: %d %s", replyRR.Code, replyRR.Body.String())
	}

	// Main timeline list excludes the reply.
	listReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+id+"/messages", nil), "channelID", id)
	listRR := httptest.NewRecorder()
	testHandler.ListChannelMessages(listRR, listReq)
	var list []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("expected 1 main-timeline msg, got %d (%+v)", len(list), list)
	}
	if list[0]["body"] != "parent" {
		t.Errorf("main timeline first row should be parent: %v", list[0]["body"])
	}
}

// --- E.1: thread API + rollup ---

// sendThreadReply is a small wrapper that posts a thread reply via the handler
// and returns the decoded message. Used by the rollup tests to keep the
// arrange phase short.
func sendThreadReply(t *testing.T, channelID, parentID, body string) map[string]any {
	t.Helper()
	req := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages",
			map[string]any{"body": body, "parent_message_id": parentID}),
		"channelID", channelID,
	)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("send reply: %d %s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	return got
}

// readChannelMessage reads the persisted channel_message row directly so tests
// can assert rollup fields independent of any future API filtering.
func readChannelMessageRollup(t *testing.T, id string) (replyCount int, lastReplyValid bool, participantsJSON []byte) {
	t.Helper()
	if err := testPool.QueryRow(context.Background(),
		`SELECT reply_count, (last_reply_at IS NOT NULL), reply_participants
		 FROM channel_message WHERE id = $1`, parseUUID(id),
	).Scan(&replyCount, &lastReplyValid, &participantsJSON); err != nil {
		t.Fatalf("read rollup: %v", err)
	}
	return
}

func TestSendChannelMessage_ThreadReplyBumpsRollup(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "rollup-bump", "public")
	channelID := c["id"].(string)

	// Seed parent.
	parentReq := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages",
			map[string]any{"body": "parent message"}),
		"channelID", channelID,
	)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	// One reply.
	sendThreadReply(t, channelID, parentID, "first reply")

	count, hasLast, partsJSON := readChannelMessageRollup(t, parentID)
	if count != 1 {
		t.Errorf("reply_count=%d want 1", count)
	}
	if !hasLast {
		t.Error("last_reply_at should be set after reply")
	}
	var parts []map[string]string
	if err := json.Unmarshal(partsJSON, &parts); err != nil {
		t.Fatalf("decode reply_participants: %v", err)
	}
	if len(parts) != 1 || parts[0]["type"] != "member" {
		t.Errorf("reply_participants=%v", parts)
	}
}

func TestSendChannelMessage_ThreadReplySameAuthorDedups(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "rollup-dedup", "public")
	channelID := c["id"].(string)

	// Seed parent.
	parentReq := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages",
			map[string]any{"body": "parent"}),
		"channelID", channelID,
	)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	// Same author replies three times.
	sendThreadReply(t, channelID, parentID, "r1")
	sendThreadReply(t, channelID, parentID, "r2")
	sendThreadReply(t, channelID, parentID, "r3")

	count, _, partsJSON := readChannelMessageRollup(t, parentID)
	if count != 3 {
		t.Errorf("reply_count=%d want 3", count)
	}
	var parts []map[string]string
	_ = json.Unmarshal(partsJSON, &parts)
	if len(parts) != 1 {
		t.Errorf("reply_participants should dedup the same author, got %d entries: %v", len(parts), parts)
	}
}

func TestSendChannelMessage_ThreadReplyPublishesRollupEvent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ch := make(chan events.Event, 1)
	testHandler.Bus.Subscribe(events.KindChannelThreadRollup, func(e events.Event) {
		select {
		case ch <- e:
		default:
		}
	})

	c := mustCreateChannel(t, "rollup-event", "public")
	channelID := c["id"].(string)

	parentReq := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages",
			map[string]any{"body": "parent"}),
		"channelID", channelID,
	)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	// Drain any earlier event before reply.
	select {
	case <-ch:
	default:
	}

	sendThreadReply(t, channelID, parentID, "thread reply")

	select {
	case e := <-ch:
		if e.Type != events.KindChannelThreadRollup {
			t.Errorf("type=%s", e.Type)
		}
		p, ok := e.Payload.(events.ChannelThreadRollupPayload)
		if !ok {
			t.Fatalf("payload type=%T", e.Payload)
		}
		if p.ChannelID != channelID {
			t.Errorf("payload.channel_id=%s want %s", p.ChannelID, channelID)
		}
		if p.ParentMessageID != parentID {
			t.Errorf("payload.parent_message_id=%s want %s", p.ParentMessageID, parentID)
		}
		if p.ReplyCount != 1 {
			t.Errorf("payload.reply_count=%d want 1", p.ReplyCount)
		}
		if p.LastReplyAt == nil {
			t.Error("payload.last_reply_at should be set")
		}
	default:
		t.Fatal("channel:thread:rollup not delivered synchronously")
	}
}

func TestGetChannelThread_ReturnsParentAndReplies(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "thread-fetch", "public")
	channelID := c["id"].(string)

	parentReq := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages",
			map[string]any{"body": "parent"}),
		"channelID", channelID,
	)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	sendThreadReply(t, channelID, parentID, "reply A")
	sendThreadReply(t, channelID, parentID, "reply B")

	req := withURLParams(
		newRequest(http.MethodGet, "/api/channels/"+channelID+"/threads/"+parentID, nil),
		"channelID", channelID,
		"parentID", parentID,
	)
	rr := httptest.NewRecorder()
	testHandler.GetChannelThread(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var rows []map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&rows)
	if len(rows) != 3 {
		t.Fatalf("want 3 rows (parent+2 replies), got %d", len(rows))
	}
	if rows[0]["body"] != "parent" {
		t.Errorf("rows[0]=%v want parent first (chronological)", rows[0]["body"])
	}
	if rows[1]["body"] != "reply A" || rows[2]["body"] != "reply B" {
		t.Errorf("reply order wrong: %v / %v", rows[1]["body"], rows[2]["body"])
	}
}

func TestGetChannelThread_ParentInWrongChannel_404(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	chA := mustCreateChannel(t, "thread-cross-a", "public")
	chB := mustCreateChannel(t, "thread-cross-b", "public")
	chAID := chA["id"].(string)
	chBID := chB["id"].(string)

	// Parent lives in channel A.
	parentReq := withURLParam(
		newRequest(http.MethodPost, "/api/channels/"+chAID+"/messages",
			map[string]any{"body": "parent in A"}),
		"channelID", chAID,
	)
	parentRR := httptest.NewRecorder()
	testHandler.SendChannelMessage(parentRR, parentReq)
	var parent map[string]any
	_ = json.NewDecoder(parentRR.Body).Decode(&parent)
	parentID := parent["id"].(string)

	// Query parent via channel B's URL.
	req := withURLParams(
		newRequest(http.MethodGet, "/api/channels/"+chBID+"/threads/"+parentID, nil),
		"channelID", chBID,
		"parentID", parentID,
	)
	rr := httptest.NewRecorder()
	testHandler.GetChannelThread(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("cross-channel parent must 404, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestGetChannelThread_PrivateChannelRejectsNonMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	otherUserEmail := fmt.Sprintf("e1-other-%d@x.com", time.Now().UnixNano())
	var otherUserID, otherMemberID, channelID, parentID string
	if err := testPool.QueryRow(ctx, `INSERT INTO "user"(name, email) VALUES('e1-other', $1) RETURNING id::text`, otherUserEmail).Scan(&otherUserID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx,
		`INSERT INTO member(workspace_id, user_id, role) VALUES($1, $2, 'member') RETURNING id::text`,
		parseUUID(testWorkspaceID), parseUUID(otherUserID),
	).Scan(&otherMemberID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx,
		`INSERT INTO channel(workspace_id, name, kind, creator_member_id) VALUES($1, 'e1-private-thread', 'private', $2) RETURNING id::text`,
		parseUUID(testWorkspaceID), parseUUID(otherMemberID),
	).Scan(&channelID); err != nil {
		t.Fatal(err)
	}
	// Other user is the only channel_member.
	if _, err := testPool.Exec(ctx, `INSERT INTO channel_member(channel_id, member_type, member_id) VALUES($1, 'member', $2)`,
		parseUUID(channelID), parseUUID(otherMemberID),
	); err != nil {
		t.Fatal(err)
	}
	// Seed a parent message authored by the other user (testUserID is not in
	// the channel and would be rejected at SendChannelMessage).
	if err := testPool.QueryRow(ctx,
		`INSERT INTO channel_message(channel_id, author_type, author_id, body, delivery_status)
		 VALUES($1, 'member', $2, 'parent', 'complete') RETURNING id::text`,
		parseUUID(channelID), parseUUID(otherMemberID),
	).Scan(&parentID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel WHERE id = $1`, parseUUID(channelID))
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, parseUUID(otherUserID))
	})

	req := withURLParams(
		newRequest(http.MethodGet, "/api/channels/"+channelID+"/threads/"+parentID, nil),
		"channelID", channelID,
		"parentID", parentID,
	)
	rr := httptest.NewRecorder()
	testHandler.GetChannelThread(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("private non-member must 404, got %d", rr.Code)
	}
}

func TestSendChannelMessage_PublishesEvent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	// Subscribe to the channel message kind BEFORE acting. Because the bus
	// dispatches handlers synchronously, the event is delivered before
	// Publish() returns — no sleep or polling needed.
	ch := make(chan events.Event, 1)
	testHandler.Bus.Subscribe(events.KindChannelMessageCreated, func(e events.Event) {
		select {
		case ch <- e:
		default:
		}
	})

	c := mustCreateChannel(t, "broadcast-test", "public")
	channelID := c["id"].(string)
	body := map[string]any{"body": "ping"}
	req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages", body), "channelID", channelID)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}

	// Bus dispatch is synchronous, so by the time Publish() returns the buffered
	// channel must already hold the event. A `default` arm — not a timeout —
	// guarantees the test fails immediately if a future refactor breaks that.
	select {
	case e := <-ch:
		if e.Type != events.KindChannelMessageCreated {
			t.Errorf("type=%s", e.Type)
		}
		if e.WorkspaceID != testWorkspaceID {
			t.Errorf("workspace_id=%s want %s", e.WorkspaceID, testWorkspaceID)
		}
	default:
		t.Fatal("event was not delivered synchronously by Publish()")
	}
}

func TestPutChannelMember_AgentInWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "agent-member", "private")
	channelID := c["id"].(string)

	// Seed an agent in the test workspace.
	agentID := createHandlerTestAgent(t, "stub-agent-c1", []byte(`{}`))
	memberRef := "agent:" + agentID

	req := withURLParams(
		newRequest(http.MethodPut, "/api/channels/"+channelID+"/members/"+memberRef, map[string]any{}),
		"channelID", channelID, "memberRef", memberRef,
	)
	rr := httptest.NewRecorder()
	testHandler.PutChannelMember(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("agent add: %d %s", rr.Code, rr.Body.String())
	}

	// List should include the agent.
	listReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+channelID+"/members", nil), "channelID", channelID)
	listRR := httptest.NewRecorder()
	testHandler.ListChannelMembers(listRR, listReq)
	var members []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&members)
	foundAgent := false
	for _, m := range members {
		if m["member_type"] == "agent" && m["member_id"] == agentID {
			foundAgent = true
		}
	}
	if !foundAgent {
		t.Errorf("agent not in member list: %+v", members)
	}
}

func TestSendChannelMessage_ResolvesAgentMention(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "mention-test", "public")
	channelID := c["id"].(string)
	agentID := createHandlerTestAgent(t, "claude-c1", []byte(`{}`))

	body := map[string]any{"body": "hey @claude-c1 can you help"}
	req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages", body), "channelID", channelID)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("send: %d %s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	mentions, _ := got["mentions"].([]any)
	if len(mentions) != 1 {
		t.Fatalf("want 1 mention, got %d (%+v)", len(mentions), mentions)
	}
	first := mentions[0].(map[string]any)
	if first["type"] != "agent" {
		t.Errorf("type=%v", first["type"])
	}
	if first["id"] != agentID {
		t.Errorf("id=%v want %v", first["id"], agentID)
	}
}

func TestSendChannelMessage_DropsUnknownMention(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "unknown-mention", "public")
	channelID := c["id"].(string)

	body := map[string]any{"body": "hello @nobody-xyz-789"}
	req := withURLParam(newRequest(http.MethodPost, "/api/channels/"+channelID+"/messages", body), "channelID", channelID)
	rr := httptest.NewRecorder()
	testHandler.SendChannelMessage(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d", rr.Code)
	}
	var got map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&got)
	mentions, _ := got["mentions"].([]any)
	if len(mentions) != 0 {
		t.Errorf("expected zero mentions, got %d (%+v)", len(mentions), mentions)
	}
}

// ---------------------------------------------------------------------------
// Streaming agent reply — query-level tests (C.4)
// ---------------------------------------------------------------------------

// seedStreamingFixture creates a channel + agent and returns (channelID UUID, agentID UUID).
func seedStreamingFixture(t *testing.T, suffix string) (channelID, agentID string) {
	t.Helper()
	c := mustCreateChannel(t, "stream-"+suffix, "public")
	channelID = c["id"].(string)
	agentID = createHandlerTestAgent(t, "stream-agent-"+suffix, []byte(`{}`))
	return
}

// insertStreamingTask inserts a minimal agent_task_queue row for a channel task
// and returns the task id. This bypasses the dispatcher so we can test the
// query helpers directly.
func insertStreamingTask(t *testing.T, channelID, agentID string) string {
	t.Helper()
	runtimeID := handlerTestRuntimeID(t)
	var taskID string
	err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue
			(agent_id, channel_id, runtime_id, status, priority)
		VALUES ($1, $2, $3, 'running', 0)
		RETURNING id
	`, parseUUID(agentID), parseUUID(channelID), parseUUID(runtimeID)).Scan(&taskID)
	if err != nil {
		t.Fatalf("insertStreamingTask: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})
	return taskID
}

func TestStreaming_PrepareInsertsPlaceholder(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	channelID, agentID := seedStreamingFixture(t, "prepare")
	taskID := insertStreamingTask(t, channelID, agentID)

	ctx := context.Background()
	msg, err := testHandler.Queries.PrepareAgentChannelMessage(ctx, db.PrepareAgentChannelMessageParams{
		ChannelID: parseUUID(channelID),
		AuthorID:  parseUUID(agentID),
		TaskID:    parseUUID(taskID),
	})
	if err != nil {
		t.Fatalf("PrepareAgentChannelMessage: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})

	if msg.Body != "" {
		t.Errorf("body want empty, got %q", msg.Body)
	}
	if msg.DeliveryStatus != "streaming" {
		t.Errorf("delivery_status want streaming, got %q", msg.DeliveryStatus)
	}
	if uuidToString(msg.TaskID) != taskID {
		t.Errorf("task_id want %s, got %s", taskID, uuidToString(msg.TaskID))
	}
	if msg.AuthorType != "agent" {
		t.Errorf("author_type want agent, got %s", msg.AuthorType)
	}
}

func TestStreaming_AppendUpdatesBody(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	channelID, agentID := seedStreamingFixture(t, "append")
	taskID := insertStreamingTask(t, channelID, agentID)

	ctx := context.Background()
	msg, err := testHandler.Queries.PrepareAgentChannelMessage(ctx, db.PrepareAgentChannelMessageParams{
		ChannelID: parseUUID(channelID),
		AuthorID:  parseUUID(agentID),
		TaskID:    parseUUID(taskID),
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})

	// Append two chunks.
	if err := testHandler.Queries.AppendAgentChannelMessageBody(ctx, db.AppendAgentChannelMessageBodyParams{
		ID: msg.ID, Body: "Hello ",
	}); err != nil {
		t.Fatalf("append1: %v", err)
	}
	if err := testHandler.Queries.AppendAgentChannelMessageBody(ctx, db.AppendAgentChannelMessageBodyParams{
		ID: msg.ID, Body: "world",
	}); err != nil {
		t.Fatalf("append2: %v", err)
	}

	// Verify concatenation.
	var body string
	if err := testPool.QueryRow(ctx, `SELECT body FROM channel_message WHERE id = $1`, msg.ID).Scan(&body); err != nil {
		t.Fatalf("select: %v", err)
	}
	if body != "Hello world" {
		t.Errorf("body want %q, got %q", "Hello world", body)
	}
}

func TestStreaming_FinalizeComplete(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	channelID, agentID := seedStreamingFixture(t, "finalize-ok")
	taskID := insertStreamingTask(t, channelID, agentID)

	ctx := context.Background()
	msg, err := testHandler.Queries.PrepareAgentChannelMessage(ctx, db.PrepareAgentChannelMessageParams{
		ChannelID: parseUUID(channelID),
		AuthorID:  parseUUID(agentID),
		TaskID:    parseUUID(taskID),
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})

	// Append a chunk then finalize.
	_ = testHandler.Queries.AppendAgentChannelMessageBody(ctx, db.AppendAgentChannelMessageBodyParams{
		ID: msg.ID, Body: "done",
	})
	finalized, err := testHandler.Queries.FinalizeAgentChannelMessage(ctx, db.FinalizeAgentChannelMessageParams{
		ID:             msg.ID,
		DeliveryStatus: "complete",
	})
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if finalized.DeliveryStatus != "complete" {
		t.Errorf("delivery_status want complete, got %q", finalized.DeliveryStatus)
	}

	// A follow-up Append is a no-op (status guard prevents writes).
	_ = testHandler.Queries.AppendAgentChannelMessageBody(ctx, db.AppendAgentChannelMessageBodyParams{
		ID: msg.ID, Body: " extra",
	})
	var finalBody string
	testPool.QueryRow(ctx, `SELECT body FROM channel_message WHERE id = $1`, msg.ID).Scan(&finalBody)
	if finalBody != "done" {
		t.Errorf("body should stay %q after complete, got %q", "done", finalBody)
	}
}

// --- F.1: reactions ---

func TestAddChannelReaction_Idempotent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "react-add", "public")
	channelID := c["id"].(string)
	var memberID string
	_ = testPool.QueryRow(context.Background(),
		`SELECT id::text FROM member WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&memberID)
	msgID := insertTestChannelMessage(t, channelID, memberID, "react me")

	add := func() *httptest.ResponseRecorder {
		req := withURLParams(
			newRequest(http.MethodPost,
				"/api/channels/"+channelID+"/messages/"+msgID+"/reactions",
				map[string]any{"emoji": "🎉"},
			),
			"channelID", channelID,
			"messageID", msgID,
		)
		rr := httptest.NewRecorder()
		testHandler.AddChannelReaction(rr, req)
		return rr
	}

	rr := add()
	if rr.Code != http.StatusOK {
		t.Fatalf("first add: status=%d body=%s", rr.Code, rr.Body.String())
	}
	rr2 := add()
	if rr2.Code != http.StatusOK {
		t.Fatalf("second add (idempotent): status=%d body=%s", rr2.Code, rr2.Body.String())
	}

	// Underlying row count is 1 (UNIQUE constraint).
	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM channel_message_reaction WHERE message_id = $1`,
		parseUUID(msgID),
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("idempotent add should keep one row, got %d", count)
	}
}

func TestAddChannelReaction_PublishesEvent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "react-event", "public")
	channelID := c["id"].(string)
	var memberID string
	_ = testPool.QueryRow(context.Background(),
		`SELECT id::text FROM member WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&memberID)
	msgID := insertTestChannelMessage(t, channelID, memberID, "react me")

	ch := make(chan events.Event, 1)
	testHandler.Bus.Subscribe(events.KindChannelReactionAdded, func(e events.Event) {
		select {
		case ch <- e:
		default:
		}
	})

	req := withURLParams(
		newRequest(http.MethodPost,
			"/api/channels/"+channelID+"/messages/"+msgID+"/reactions",
			map[string]any{"emoji": "👀"},
		),
		"channelID", channelID,
		"messageID", msgID,
	)
	rr := httptest.NewRecorder()
	testHandler.AddChannelReaction(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	select {
	case e := <-ch:
		p, ok := e.Payload.(events.ChannelReactionAddedPayload)
		if !ok {
			t.Fatalf("payload type=%T", e.Payload)
		}
		if p.ChannelID != channelID {
			t.Errorf("channel_id=%s want %s", p.ChannelID, channelID)
		}
		if p.Reaction.Emoji != "👀" {
			t.Errorf("emoji=%q", p.Reaction.Emoji)
		}
	default:
		t.Fatal("channel:reaction:added not delivered synchronously")
	}
}

func TestRemoveChannelReaction_HappyAndMissing(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "react-remove", "public")
	channelID := c["id"].(string)
	var memberID string
	_ = testPool.QueryRow(context.Background(),
		`SELECT id::text FROM member WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&memberID)
	msgID := insertTestChannelMessage(t, channelID, memberID, "react me")

	// Seed a reaction.
	addReq := withURLParams(
		newRequest(http.MethodPost,
			"/api/channels/"+channelID+"/messages/"+msgID+"/reactions",
			map[string]any{"emoji": "🚀"},
		),
		"channelID", channelID,
		"messageID", msgID,
	)
	addRR := httptest.NewRecorder()
	testHandler.AddChannelReaction(addRR, addReq)
	if addRR.Code != http.StatusOK {
		t.Fatalf("seed: %d", addRR.Code)
	}

	// Remove it: 204.
	delReq := withURLParams(
		newRequest(http.MethodDelete,
			"/api/channels/"+channelID+"/messages/"+msgID+"/reactions/🚀", nil),
		"channelID", channelID,
		"messageID", msgID,
		"emoji", "🚀",
	)
	delRR := httptest.NewRecorder()
	testHandler.RemoveChannelReaction(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Errorf("remove: status=%d body=%s", delRR.Code, delRR.Body.String())
	}

	// Remove again: 404.
	delReq2 := withURLParams(
		newRequest(http.MethodDelete,
			"/api/channels/"+channelID+"/messages/"+msgID+"/reactions/🚀", nil),
		"channelID", channelID,
		"messageID", msgID,
		"emoji", "🚀",
	)
	delRR2 := httptest.NewRecorder()
	testHandler.RemoveChannelReaction(delRR2, delReq2)
	if delRR2.Code != http.StatusNotFound {
		t.Errorf("remove-missing: status=%d body=%s", delRR2.Code, delRR2.Body.String())
	}
}

func TestListChannelMessages_AttachesReactions(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	c := mustCreateChannel(t, "react-list", "public")
	channelID := c["id"].(string)
	var memberID string
	_ = testPool.QueryRow(context.Background(),
		`SELECT id::text FROM member WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&memberID)
	msgID := insertTestChannelMessage(t, channelID, memberID, "react attach")

	// Seed two reactions on the same message.
	for _, emoji := range []string{"🎉", "👀"} {
		req := withURLParams(
			newRequest(http.MethodPost,
				"/api/channels/"+channelID+"/messages/"+msgID+"/reactions",
				map[string]any{"emoji": emoji}),
			"channelID", channelID, "messageID", msgID,
		)
		testHandler.AddChannelReaction(httptest.NewRecorder(), req)
	}

	listReq := withURLParam(newRequest(http.MethodGet, "/api/channels/"+channelID+"/messages", nil), "channelID", channelID)
	listRR := httptest.NewRecorder()
	testHandler.ListChannelMessages(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list: %d", listRR.Code)
	}
	var rows []map[string]any
	_ = json.NewDecoder(listRR.Body).Decode(&rows)
	if len(rows) != 1 {
		t.Fatalf("want 1 msg, got %d", len(rows))
	}
	reactions, ok := rows[0]["reactions"].([]any)
	if !ok {
		t.Fatalf("reactions missing or wrong type: %v", rows[0]["reactions"])
	}
	if len(reactions) != 2 {
		t.Errorf("want 2 reactions, got %d", len(reactions))
	}
}

// E.3: when an agent's streaming reply finalizes successfully and the message
// has parent_message_id set, the daemon-side helper must bump the parent's
// thread rollup so reply_count / reply_participants stay accurate, and emit
// a channel:thread:rollup event so other tabs refresh the participant strip.
func TestFinalizeChannelStreaming_ThreadReply_BumpsRollup(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()

	channelID, agentID := seedStreamingFixture(t, "thread-rollup")

	// Add the agent as a channel_member so UpdateAgentMemberAfterReply has
	// somewhere to write — finalizeChannelStreaming logs a warning otherwise
	// but proceeds, which would also work; this keeps the test focused on
	// the rollup path rather than a noisy log assertion.
	if _, err := testPool.Exec(ctx,
		`INSERT INTO channel_member (channel_id, member_type, member_id) VALUES ($1, 'agent', $2)`,
		parseUUID(channelID), parseUUID(agentID),
	); err != nil {
		t.Fatalf("seed channel_member: %v", err)
	}

	// Seed parent message authored by the test member.
	var memberID string
	if err := testPool.QueryRow(ctx,
		`SELECT id::text FROM member WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&memberID); err != nil {
		t.Fatalf("get member: %v", err)
	}
	parentID := insertTestChannelMessage(t, channelID, memberID, "parent")

	taskID := insertStreamingTask(t, channelID, agentID)
	// Inject parent_message_id into the task's context JSONB — the new
	// finalize path reads channelParentMessageID(task) from there to set
	// the thread parent on the inserted reply row. Without this the row
	// would be top-level and the rollup wouldn't fire.
	taskCtxJSON, _ := json.Marshal(map[string]any{
		"channel_id":         channelID,
		"trigger_message_id": parentID,
		"parent_message_id":  parentID,
	})
	if _, err := testPool.Exec(ctx,
		`UPDATE agent_task_queue SET context = $1 WHERE id = $2`,
		taskCtxJSON, parseUUID(taskID),
	); err != nil {
		t.Fatalf("set task context: %v", err)
	}

	// Subscribe to the rollup event before triggering finalize.
	rollupCh := make(chan events.Event, 1)
	testHandler.Bus.Subscribe(events.KindChannelThreadRollup, func(e events.Event) {
		select {
		case rollupCh <- e:
		default:
		}
	})

	// Build the task row the helper expects, including the context blob so
	// channelParentMessageID resolves the parent.
	var task db.AgentTaskQueue
	if err := testPool.QueryRow(ctx,
		`SELECT id, agent_id, channel_id, context FROM agent_task_queue WHERE id = $1`,
		parseUUID(taskID),
	).Scan(&task.ID, &task.AgentID, &task.ChannelID, &task.Context); err != nil {
		t.Fatalf("load task: %v", err)
	}

	testHandler.finalizeChannelStreaming(ctx, task, testWorkspaceID, true, "", "agent reply body")

	// Parent rollup row reflects the agent's reply.
	var replyCount int
	var partsJSON []byte
	if err := testPool.QueryRow(ctx,
		`SELECT reply_count, reply_participants FROM channel_message WHERE id = $1`,
		parseUUID(parentID),
	).Scan(&replyCount, &partsJSON); err != nil {
		t.Fatalf("read parent rollup: %v", err)
	}
	if replyCount != 1 {
		t.Errorf("reply_count=%d want 1", replyCount)
	}
	var parts []map[string]string
	_ = json.Unmarshal(partsJSON, &parts)
	if len(parts) != 1 || parts[0]["type"] != "agent" || parts[0]["id"] != agentID {
		t.Errorf("reply_participants=%v want one entry [agent, %s]", parts, agentID)
	}

	// Event was published synchronously.
	select {
	case e := <-rollupCh:
		p, ok := e.Payload.(events.ChannelThreadRollupPayload)
		if !ok {
			t.Fatalf("payload type=%T", e.Payload)
		}
		if p.ParentMessageID != parentID {
			t.Errorf("event parent_message_id=%s want %s", p.ParentMessageID, parentID)
		}
		if p.ReplyCount != 1 {
			t.Errorf("event reply_count=%d want 1", p.ReplyCount)
		}
	default:
		t.Fatal("channel:thread:rollup not published synchronously by finalize helper")
	}
}

func TestStreaming_FinalizeFailed(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	channelID, agentID := seedStreamingFixture(t, "finalize-fail")
	taskID := insertStreamingTask(t, channelID, agentID)

	ctx := context.Background()
	msg, err := testHandler.Queries.PrepareAgentChannelMessage(ctx, db.PrepareAgentChannelMessageParams{
		ChannelID: parseUUID(channelID),
		AuthorID:  parseUUID(agentID),
		TaskID:    parseUUID(taskID),
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM channel_message WHERE id = $1`, msg.ID)
	})

	finalized, err := testHandler.Queries.FinalizeAgentChannelMessage(ctx, db.FinalizeAgentChannelMessageParams{
		ID:             msg.ID,
		DeliveryStatus: "failed",
		FailureReason:  pgtype.Text{String: "agent_error", Valid: true},
	})
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if finalized.DeliveryStatus != "failed" {
		t.Errorf("delivery_status want failed, got %q", finalized.DeliveryStatus)
	}
	if !finalized.FailureReason.Valid || finalized.FailureReason.String != "agent_error" {
		t.Errorf("failure_reason want agent_error, got %+v", finalized.FailureReason)
	}
}
