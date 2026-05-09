import type { QueryClient } from "@tanstack/react-query";
import { channelKeys } from "./queries";
import { useChannelThinkingStore } from "./store";

interface ChannelEnvelope {
  type: string;
  payload: any;
  workspace_id?: string;
  actor_id?: string;
}

/**
 * Applies a `channel:*` WS event to the TanStack Query cache via invalidation.
 * Never writes to the cache directly — invalidation triggers a refetch which is
 * authoritative.
 *
 * Workspace-scoped invalidations require `event.workspace_id` to be present in
 * the envelope (server side: events.Event.WorkspaceID). Channel-scoped
 * invalidations read `channel_id` / `message_id` / `parent_message_id` out of
 * the payload.
 */
export function applyChannelEvent(qc: QueryClient, event: ChannelEnvelope): void {
  const wsId = event.workspace_id ?? "";
  const p = event.payload as Record<string, any> | undefined;

  switch (event.type) {
    case "channel:agent:thinking": {
      const channelId: string | undefined = p?.channel_id;
      const agentId: string | undefined = p?.agent_id;
      // parent_message_id is omitempty on the wire — main-channel
      // dispatches arrive without it. Treat undefined / empty as the
      // main-channel surface key.
      const parentId: string | undefined = p?.parent_message_id || undefined;
      if (channelId && agentId) {
        useChannelThinkingStore.getState().startThinking(channelId, agentId, parentId);
      }
      break;
    }
    case "channel:created":
    case "channel:archived": {
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
      break;
    }
    case "channel:updated": {
      const channelId: string | undefined = p?.id;
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.detail(wsId, channelId) });
      }
      break;
    }
    case "channel:member:added":
    case "channel:member:removed": {
      const channelId: string | undefined = p?.channel_id;
      // List can change too: a private channel becomes visible/invisible to caller
      // depending on whether the affected member is them.
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.members(wsId, channelId) });
      }
      break;
    }
    case "channel:message:created":
    case "channel:message:completed": {
      const channelId: string | undefined = p?.channel_id;
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
      }
      // Implicit thinking-end signal: when an agent's reply lands, drop
      // them from the thinking set. Server doesn't need to publish a
      // separate "thinking-end" event — the message arriving IS the end.
      // The thinking set is keyed by (channel, parent), so the message's
      // own parent_message_id picks the right surface to clear.
      const authorType: string | undefined = p?.author_type;
      const authorId: string | undefined = p?.author_id;
      const parentId: string | undefined = p?.parent_message_id || undefined;
      if (channelId && authorType === "agent" && authorId) {
        useChannelThinkingStore.getState().stopThinking(channelId, authorId, parentId);
      }
      break;
    }
    case "channel:message:patched": {
      // Streaming token updates; same key as messages.
      const channelId: string | undefined = p?.channel_id;
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
      }
      break;
    }
    case "channel:thread:rollup": {
      const channelId: string | undefined = p?.channel_id;
      const parentId: string | undefined = p?.parent_message_id;
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
        if (parentId) {
          qc.invalidateQueries({ queryKey: channelKeys.thread(channelId, parentId) });
        }
      }
      break;
    }
    case "channel:reaction:added":
    case "channel:reaction:removed": {
      const channelId: string | undefined = p?.channel_id;
      if (channelId) {
        qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
      }
      break;
    }
  }
}
