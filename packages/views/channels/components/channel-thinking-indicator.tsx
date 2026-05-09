"use client";

import { useQuery } from "@tanstack/react-query";
import { channelThinkingKey, useChannelThinkingStore } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import { agentListOptions } from "@folio/core/workspace/queries";
import { useT } from "../../i18n";

/**
 * "<agent> is replying…" indicator rendered between the message list and the
 * composer. Driven entirely by the channels thinking store, which is itself
 * driven by `channel:agent:thinking` WS events on dispatch and implicit
 * removal when the agent's `channel:message:created` arrives.
 *
 * The indicator is scoped to a *surface*: main channel when `parentId` is
 * omitted, or a specific thread when `parentId` is the parent message UUID.
 * Both surfaces can show simultaneously without leaking — main-channel
 * typing won't bleed into an open thread drawer because the store key
 * encodes parentId.
 *
 * Returns null when no agent is currently thinking on this surface — keeps
 * the indicator from reserving vertical space when idle.
 */
export function ChannelThinkingIndicator({
  channelId,
  parentId,
}: {
  channelId: string;
  parentId?: string;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  const { data: agents = [] } = useQuery(agentListOptions(wsId));

  // Selecting `Set<string> | undefined` directly would re-render on every
  // store update because Set instance identity changes; the indicator only
  // cares about the ids list. Build a sorted-id string we can compare
  // shallowly + an array for rendering.
  const surfaceKey = channelThinkingKey(channelId, parentId);
  const ids = useChannelThinkingStore((s) => s.thinking[surfaceKey]);
  if (!ids || ids.size === 0) return null;

  const idsArray = [...ids];
  const fallback = t(($) => $.thinking.fallback_name);
  const names = idsArray
    .map((id) => agents.find((a) => a.id === id)?.name ?? fallback)
    .sort((a, b) => a.localeCompare(b));

  let label: string;
  if (names.length === 1) {
    label = t(($) => $.thinking.one, { name: names[0]! });
  } else if (names.length === 2) {
    label = t(($) => $.thinking.two, { first: names[0]!, second: names[1]! });
  } else {
    label = t(($) => $.thinking.many, {
      first: names[0]!,
      second: names[1]!,
      count: names.length - 2,
    });
  }

  return (
    <div
      data-testid="channel-thinking-indicator"
      className="px-4 py-1 text-xs text-muted-foreground italic flex items-center gap-2"
    >
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <Dot delay="0ms" />
        <Dot delay="120ms" />
        <Dot delay="240ms" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  // Three dots that pulse at staggered phases — same ASCII-only pattern as
  // chat's typing indicator, no new asset / library required.
  return (
    <span
      className="size-1 rounded-full bg-muted-foreground animate-pulse"
      style={{ animationDelay: delay }}
    />
  );
}
