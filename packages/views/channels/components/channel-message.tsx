"use client";

import { useQuery } from "@tanstack/react-query";
import { type ChannelMessage } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import {
  agentListOptions,
  memberListOptions,
} from "@folio/core/workspace/queries";
import { cn } from "@folio/ui/lib/utils";
import { useT } from "../../i18n";
import { ChannelAuthorAvatar } from "./channel-author-avatar";
import { ChannelReactionsBar } from "./channel-reactions-bar";

export function ChannelMessageRow({
  msg,
  onOpenThread,
  isContinuation = false,
}: {
  msg: ChannelMessage;
  /**
   * Optional handler invoked when the user clicks "Reply" or the reply-count
   * chip on a parent message. The thread drawer renders rows without this
   * handler so reply links don't appear inside an already-open thread.
   */
  onOpenThread?: (parentId: string) => void;
  /**
   * When true this row is a follow-up from the same author as the previous
   * row; we hide the avatar + name + timestamp and indent the body to align
   * with the leader's body — the standard Slack/iMessage grouping pattern.
   * The list owner decides whether a row counts as continuation.
   */
  isContinuation?: boolean;
}) {
  const { t } = useT("channels");
  const wsId = useWorkspaceId();
  // Resolve author_id → display name. Both queries are workspace-scoped and
  // already cached by other channel components, so this row contributes no
  // new network traffic. UUID head fallback keeps the row legible while the
  // list is still loading or when an author was archived/removed.
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const authorName = (() => {
    if (!msg.author_id) return "…";
    if (msg.author_type === "agent") {
      return agents.find((a) => a.id === msg.author_id)?.name ?? msg.author_id.slice(0, 8);
    }
    return members.find((m) => m.id === msg.author_id)?.name ?? msg.author_id.slice(0, 8);
  })();
  // Replies are flat for now — the thread drawer fetches them as a flat list
  // off the parent. We hide the per-row reply controls when the row itself is
  // a reply to keep the UI simple; threading-of-threads is out of scope.
  const isThreadReply = msg.parent_message_id !== null;
  const showThreadControls = onOpenThread && !isThreadReply;
  const hasReplies = msg.reply_count > 0;
  const failureLabel =
    msg.delivery_status === "failed"
      ? msg.failure_reason === "agent_error"
        ? t(($) => $.messages.failure.agent_error)
        : msg.failure_reason === "connection_error"
          ? t(($) => $.messages.failure.connection_error)
          : msg.failure_reason === "timeout"
            ? t(($) => $.messages.failure.timeout)
            : t(($) => $.messages.failure.default)
      : "";

  return (
    <li
      data-testid="channel-message"
      className={cn(
        "px-4 text-sm group",
        // Group spacing: leading rows get a comfortable margin from the
        // previous group; continuations sit tight against their leader.
        isContinuation ? "py-0.5" : "pt-3 pb-1",
        msg.delivery_status === "streaming" && "opacity-70",
        msg.delivery_status === "failed" &&
          "bg-destructive/10 border-l-2 border-destructive",
      )}
    >
      <div className="flex gap-2">
        {isContinuation ? (
          <div className="w-8 shrink-0" aria-hidden="true" />
        ) : (
          <ChannelAuthorAvatar
            authorId={msg.author_id || authorName}
            authorName={authorName}
            isAgent={msg.author_type === "agent"}
            size={32}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {!isContinuation && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <span className="font-medium text-foreground">{authorName}</span>
              <span>·</span>
              <span>{new Date(msg.created_at).toLocaleTimeString()}</span>
              {msg.delivery_status === "streaming" && (
                <span className="italic">{t(($) => $.messages.streaming)}</span>
              )}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{msg.body}</div>
          {msg.delivery_status === "failed" && (
            <div className="text-xs text-destructive mt-0.5 flex flex-col gap-0.5">
              <span>{failureLabel}</span>
              <span className="text-muted-foreground">{t(($) => $.messages.retry_hint)}</span>
            </div>
          )}
          {/* Single reply control under the body. With replies → an
              always-visible "N replies" chip (it's also a navigation cue,
              not just an action). Without replies → a hover-revealed
              "Reply" link, low-key by default so the body stays the
              focus. Both target the same handler. */}
          {showThreadControls && (
            hasReplies ? (
              <button
                type="button"
                data-testid="channel-message-reply-count"
                className="self-start mt-1 text-xs text-primary hover:underline"
                onClick={() => onOpenThread!(msg.id)}
              >
                {t(($) => $.messages.reply_count, { count: msg.reply_count })}
              </button>
            ) : (
              <button
                type="button"
                data-testid="channel-message-reply-button"
                className="self-start mt-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-primary hover:underline transition-opacity"
                onClick={() => onOpenThread!(msg.id)}
              >
                {t(($) => $.messages.reply_button)}
              </button>
            )
          )}
          {/* Don't show reactions on streaming or failed rows — both are
              transient states that wouldn't render meaningful reactions. */}
          {msg.delivery_status === "complete" && (
            <ChannelReactionsBar channelId={msg.channel_id} message={msg} />
          )}
        </div>
      </div>
    </li>
  );
}
