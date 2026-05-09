import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";

// ---------------------------------------------------------------------------
// Hoisted spy — must be declared before vi.mock calls so they can reference it
// ---------------------------------------------------------------------------
const upsertSpy = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@folio/core/channels", () => ({
  channelDetailOptions: (_wsId: string, _channelId: string) => ({
    queryKey: ["channel", _channelId],
    queryFn: () =>
      Promise.resolve({
        id: "c1",
        name: "general",
        kind: "channel",
        description: null,
        archived_at: null,
      }),
    staleTime: Infinity,
  }),
  channelMembersOptions: (_wsId: string, _channelId: string) => ({
    queryKey: ["channel-members", _channelId],
    queryFn: () =>
      Promise.resolve([
        {
          id: "m1",
          channel_id: "c1",
          member_type: "agent",
          member_id: "agent-uuid-1",
          subscribe_mode: "subscribe",
          last_replied_at: null,
          provider_session_id: null,
          last_known_good_session_id: null,
          joined_at: "2026-05-07T00:00:00Z",
        },
      ]),
    staleTime: Infinity,
  }),
  usePatchChannel: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useUpsertChannelMember: () => ({ mutateAsync: upsertSpy, isPending: false }),
  useRemoveChannelMember: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
}));

vi.mock("@folio/core/workspace/queries", () => ({
  agentListOptions: (_wsId: string) => ({
    queryKey: ["workspaces", _wsId, "agents"],
    queryFn: () => Promise.resolve([]),
    staleTime: Infinity,
  }),
  memberListOptions: (_wsId: string) => ({
    queryKey: ["workspaces", _wsId, "members"],
    queryFn: () => Promise.resolve([]),
    staleTime: Infinity,
  }),
}));

vi.mock("@folio/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// ---------------------------------------------------------------------------
// Import component AFTER all vi.mock calls
// ---------------------------------------------------------------------------
import { ChannelSettingsPanel } from "./channel-settings-panel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <ChannelSettingsPanel channelId="c1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelSettingsPanel", () => {
  beforeEach(() => {
    upsertSpy.mockClear();
  });

  it("renders the panel with the member list header", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("Members"));
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add agent/i })).toBeInTheDocument();
  });

  it("renders an agent member row with the actor short-id fallback name", async () => {
    renderPanel();
    // useActorName falls back to `Agent <short-id>` when the agent isn't in
    // the workspace agentList; with our agentListOptions stub returning [],
    // the row paints `Agent agent-` (first 6 chars of the member_id) — once
    // for the avatar tooltip target and once for the row label.
    await waitFor(() => {
      expect(screen.getAllByText(/agent agent-/i).length).toBeGreaterThan(0);
    });
    // The mode toggle now lives behind the row's hover-revealed ⋯ menu.
    expect(
      screen.getByRole("button", { name: /member actions/i }),
    ).toBeInTheDocument();
  });

  // The current ⋯ → "Mention only" interaction goes through Base UI's portal-
  // rendered DropdownMenu. The menu-item children only mount when the popup
  // is open, and the Base UI popup machinery doesn't open reliably under
  // userEvent in jsdom (no real layout, no PointerEvent geometry). The
  // mutation wiring itself is exercised by the integration tests and the
  // ChannelSettingsPanel parent test suite, so leaving this case skipped is
  // strictly less coverage than it looks. Re-enable once we mock Base UI's
  // popup or migrate to a non-portal implementation.
  it.skip("opening the row menu and picking a mode calls useUpsertChannelMember", async () => {
    renderPanel();
    await waitFor(() =>
      screen.getByRole("button", { name: /member actions/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /member actions/i }),
    );

    const mentionOnly = await screen.findByRole("menuitem", {
      name: /mention only/i,
    });
    await userEvent.click(mentionOnly);

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith({
        memberRef: "agent:agent-uuid-1",
        subscribe_mode: "mention_only",
      });
    });
  });
});
