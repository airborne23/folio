import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Hoisted spy — must be declared before vi.mock calls so they can reference it
// ---------------------------------------------------------------------------
const upsertSpy = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@folio/core/channels", () => ({
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
  return render(
    <QueryClientProvider client={qc}>
      <ChannelSettingsPanel channelId="c1" />
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

  it("renders agent member with subscribe_mode select", async () => {
    renderPanel();
    // The member_id is sliced to 8 chars in the component: "agent-uu"
    await waitFor(() => screen.getByText(/agent-uu/i));
    // The combobox is rendered for the agent row
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("changing the select calls useUpsertChannelMember with the new mode", async () => {
    renderPanel();
    await waitFor(() => screen.getByRole("combobox"));

    const trigger = screen.getByRole("combobox");
    await userEvent.click(trigger);

    const mentionOnly = await screen.findByRole("option", { name: /mention only/i });
    await userEvent.click(mentionOnly);

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith({
        memberRef: "agent:agent-uuid-1",
        subscribe_mode: "mention_only",
      });
    });
  });
});
