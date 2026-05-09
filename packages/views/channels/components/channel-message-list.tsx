"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { channelMessagesOptions } from "@folio/core/channels";
import { useT } from "../../i18n";
import { ChannelMessageRow } from "./channel-message";

const NEAR_BOTTOM_PX = 80;

// Group consecutive messages from the same author together when they fall
// within this window. 5 minutes matches Slack/iMessage; long enough that a
// "let me think… ok here's another thought" doesn't fragment, short enough
// that "tomorrow's reply" gets its own header. Failed and streaming rows
// always start a new group so the failure / typing indicator visually
// separates them from prior content.
const CONTINUATION_WINDOW_MS = 5 * 60 * 1000;

export function ChannelMessageList({
  channelId,
  onOpenThread,
}: {
  channelId: string;
  onOpenThread?: (parentId: string) => void;
}) {
  const { t } = useT("channels");
  const { data: messages } = useSuspenseQuery(channelMessagesOptions(channelId));
  const ordered = [...messages].reverse();

  // Pre-compute continuation flags so the row component stays dumb. A row
  // is a continuation when its predecessor was authored by the same actor,
  // both completed (streaming/failed always start fresh), and the gap
  // between them is under CONTINUATION_WINDOW_MS.
  const continuationFlags = useMemo(() => {
    return ordered.map((m, i) => {
      if (i === 0) return false;
      const prev = ordered[i - 1]!;
      if (prev.author_type !== m.author_type) return false;
      if (prev.author_id !== m.author_id) return false;
      if (prev.delivery_status !== "complete" || m.delivery_status !== "complete") return false;
      const gap = new Date(m.created_at).getTime() - new Date(prev.created_at).getTime();
      return gap >= 0 && gap <= CONTINUATION_WINDOW_MS;
    });
  }, [ordered]);
  // Signature changes whenever the bottom row's identity OR its body grows.
  // The body-length component matters because the agent's streaming
  // placeholder lands first with body="" and the same row's body fills in
  // on finalize — id alone wouldn't catch that transition and the view
  // would feel "stuck" while the reply finishes loading.
  const lastSig = ordered.length
    ? `${ordered[ordered.length - 1]!.id}:${ordered[ordered.length - 1]!.body.length}`
    : null;

  // Auto-scroll: stick to the bottom when a new message arrives or the
  // bottom row grows, but ONLY when the user is already near the bottom.
  // Scrolling up to read history should not get yanked back down by an
  // incoming reply. Threshold is 80px so a user who's a few rows above the
  // floor still tracks new messages, while someone 2k px deep into history
  // doesn't.
  //
  // useLayoutEffect runs before paint so the new row is never visible at
  // the wrong scroll position — avoids the "row appears at top, then jumps
  // to bottom" flash.
  const scrollerRef = useRef<HTMLUListElement>(null);
  const isNearBottomRef = useRef(true);
  const lastSigRef = useRef<string | null>(null);

  // Track whether the user is near the bottom on every scroll. Reading
  // scroll position during render is unreliable (DOM measurements are
  // post-commit), so this lives in a ref + onScroll.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_PX;
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const isFirstRender = lastSigRef.current === null;
    const sigChanged = lastSig !== lastSigRef.current;
    lastSigRef.current = lastSig;
    if (!sigChanged && !isFirstRender) return;
    if (isFirstRender || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastSig]);

  // On channel switch the component remounts so the scroll resets to top
  // by default; force-bottom on first render handles that. Add a defensive
  // re-scroll once images / late-loading rows finish layout (covers the
  // edge case where the initial scrollHeight under-counted).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !lastSig) return;
    const t = window.setTimeout(() => {
      if (isNearBottomRef.current) el.scrollTop = el.scrollHeight;
    }, 50);
    return () => window.clearTimeout(t);
  }, [lastSig]);

  return (
    <ul
      ref={scrollerRef}
      onScroll={onScroll}
      data-testid="channel-message-list"
      className="flex-1 overflow-y-auto py-2"
    >
      {ordered.length === 0 ? (
        <li className="text-muted-foreground text-sm px-4 py-8 text-center">
          {t(($) => $.messages.empty)}
        </li>
      ) : (
        ordered.map((m, i) => (
          <ChannelMessageRow
            key={m.id}
            msg={m}
            onOpenThread={onOpenThread}
            isContinuation={continuationFlags[i]}
          />
        ))
      )}
    </ul>
  );
}
