"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@folio/ui/lib/utils";
import { useAuthStore } from "@folio/core/auth";
import { useWorkspaceId } from "@folio/core/hooks";
import { memberListOptions } from "@folio/core/workspace/queries";
import {
  useToggleChannelReaction,
  type ChannelReaction,
} from "@folio/core/channels";
import { useT } from "../../i18n";

// Quick-pick palette mirrors Slack's defaults — small enough to fit in a popover
// without scroll, broad enough to cover the most common reactions.
const QUICK_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀", "🙏", "🔥", "✅"];

interface AggregatedReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

function aggregate(reactions: ChannelReaction[], myMemberId: string | null): AggregatedReaction[] {
  const byEmoji = new Map<string, AggregatedReaction>();
  for (const r of reactions) {
    const existing = byEmoji.get(r.emoji);
    const isMine = !!myMemberId && r.reactor_type === "member" && r.reactor_id === myMemberId;
    if (existing) {
      existing.count += 1;
      existing.mine = existing.mine || isMine;
    } else {
      byEmoji.set(r.emoji, { emoji: r.emoji, count: 1, mine: isMine });
    }
  }
  return [...byEmoji.values()];
}

/**
 * Inline reactions strip rendered below each message. Existing reactions
 * appear as chips with count + "mine" highlight; clicking toggles. The
 * trailing "+" button opens a quick-pick palette.
 *
 * Empty-reactions case: still mounts the picker button so users can react.
 * The chips list collapses to nothing.
 */
export function ChannelReactionsBar({
  channelId,
  message,
}: {
  channelId: string;
  message: { id: string; reactions: ChannelReaction[] };
}) {
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const myMemberId = user
    ? (members.find((m) => m.user_id === user.id)?.id ?? null)
    : null;
  const { t } = useT("channels");

  const toggle = useToggleChannelReaction(channelId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const aggregated = aggregate(message.reactions ?? [], myMemberId);

  const onClickEmoji = async (emoji: string, mine: boolean) => {
    setPickerOpen(false);
    try {
      await toggle.mutateAsync({ messageId: message.id, emoji, mine });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.reactions.toggle_failed));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1" data-testid="channel-reactions-bar">
      {aggregated.map((r) => (
        <button
          key={r.emoji}
          type="button"
          data-testid="channel-reaction-chip"
          aria-label={
            r.mine
              ? t(($) => $.reactions.chip_aria_mine, { emoji: r.emoji, count: r.count })
              : t(($) => $.reactions.chip_aria, { emoji: r.emoji, count: r.count })
          }
          aria-pressed={r.mine}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent transition-colors",
            r.mine && "border-primary bg-primary/10",
          )}
          onClick={() => onClickEmoji(r.emoji, r.mine)}
        >
          <span>{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          type="button"
          data-testid="channel-reaction-add"
          aria-label={t(($) => $.reactions.add_aria)}
          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => setPickerOpen((o) => !o)}
        >
          +
        </button>
        {pickerOpen && (
          <div
            role="menu"
            data-testid="channel-reaction-picker"
            className="absolute z-10 left-0 top-full mt-1 flex flex-wrap gap-1 rounded-md border bg-popover p-2 shadow-md"
          >
            {QUICK_REACTIONS.map((emoji) => {
              const existing = aggregated.find((r) => r.emoji === emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className="rounded p-1 hover:bg-accent text-base"
                  onClick={() => onClickEmoji(emoji, !!existing?.mine)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
