import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createWorkspaceAwareStorage, registerForWorkspaceRehydration } from "../platform/workspace-storage";
import { defaultStorage } from "../platform/storage";

interface ChannelClientState {
  /** Composer text per channel — persisted so drafts survive reloads. */
  drafts: Record<string, string>;
  /** Currently-open thread parent ID per channel — persisted so users return to the same thread. */
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
          const next = { ...s.drafts };
          delete next[channelId];
          return { drafts: next };
        }),
      openThread: (channelId, parentId) =>
        set((s) => ({
          openThreadByChannel: { ...s.openThreadByChannel, [channelId]: parentId },
        })),
      closeThread: (channelId) =>
        set((s) => ({
          openThreadByChannel: { ...s.openThreadByChannel, [channelId]: null },
        })),
    }),
    {
      name: "folio_channels_client",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
    },
  ),
);

registerForWorkspaceRehydration(() => useChannelClientStore.persist.rehydrate());

// THINKING_TIMEOUT_MS guards against missed events: an agent that "started"
// but never produced a channel:message:created (e.g. crash, network loss)
// would otherwise leave a stale "is replying…" forever. 2 minutes covers
// the slowest legitimate channel reply we've seen — codex took ~58s in
// testing — with comfortable headroom.
const THINKING_TIMEOUT_MS = 2 * 60 * 1000;

// Surface key for the thinking indicator: a main-channel dispatch and a
// thread reply are two distinct "is replying…" surfaces. Encoding both
// into one key lets the indicator render in the right place without main-
// channel typing leaking into an open thread drawer (or vice versa).
//
// Empty parent → main channel. The colon separator is safe because UUIDs
// don't contain ':'.
export const channelThinkingKey = (channelId: string, parentMessageId?: string | null) =>
  `${channelId}:${parentMessageId ?? ""}`;

interface ChannelThinkingState {
  /** Set of agent_ids currently dispatched, keyed by `${channelId}:${parentMessageId ?? ""}`. */
  thinking: Record<string, Set<string>>;
  /** Per-(surface, agent) timeout id, so we can clear when the reply lands. */
  startThinking: (channelId: string, agentId: string, parentMessageId?: string | null) => void;
  stopThinking: (channelId: string, agentId: string, parentMessageId?: string | null) => void;
}

// Separate store: ephemeral state that should NOT persist across reloads —
// stale "is replying…" indicators on a fresh page would be misleading.
// Timeout handles map lives outside React state because timeout ids aren't
// serializable and don't need re-rendering on change.
const thinkingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const thinkingTimeoutKey = (surfaceKey: string, agentId: string) =>
  `${surfaceKey}|${agentId}`;

export const useChannelThinkingStore = create<ChannelThinkingState>()((set, get) => ({
  thinking: {},
  startThinking: (channelId, agentId, parentMessageId) => {
    const surfaceKey = channelThinkingKey(channelId, parentMessageId);
    const tKey = thinkingTimeoutKey(surfaceKey, agentId);
    const existing = thinkingTimeouts.get(tKey);
    if (existing) clearTimeout(existing);
    thinkingTimeouts.set(
      tKey,
      setTimeout(() => {
        thinkingTimeouts.delete(tKey);
        get().stopThinking(channelId, agentId, parentMessageId);
      }, THINKING_TIMEOUT_MS),
    );
    set((s) => {
      const prev = s.thinking[surfaceKey];
      // New Set instance every change so React Query / selectors see a
      // reference change. Skip if the agent was already in the set.
      if (prev && prev.has(agentId)) return s;
      const next = new Set(prev ?? []);
      next.add(agentId);
      return { thinking: { ...s.thinking, [surfaceKey]: next } };
    });
  },
  stopThinking: (channelId, agentId, parentMessageId) => {
    const surfaceKey = channelThinkingKey(channelId, parentMessageId);
    const tKey = thinkingTimeoutKey(surfaceKey, agentId);
    const existing = thinkingTimeouts.get(tKey);
    if (existing) {
      clearTimeout(existing);
      thinkingTimeouts.delete(tKey);
    }
    set((s) => {
      const prev = s.thinking[surfaceKey];
      if (!prev || !prev.has(agentId)) return s;
      const next = new Set(prev);
      next.delete(agentId);
      const updated = { ...s.thinking };
      if (next.size === 0) {
        delete updated[surfaceKey];
      } else {
        updated[surfaceKey] = next;
      }
      return { thinking: updated };
    });
  },
}));
