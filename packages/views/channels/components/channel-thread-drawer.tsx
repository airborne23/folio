"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@folio/ui/components/ui/button";
import {
  channelThreadOptions,
  useChannelClientStore,
} from "@folio/core/channels";
import { useT } from "../../i18n";
import { ChannelMessageRow } from "./channel-message";
import { ChannelComposer } from "./channel-composer";
import { ChannelThinkingIndicator } from "./channel-thinking-indicator";

/**
 * Right-pane thread view, opened when the user clicks a parent message's
 * "Reply" button. Shows the parent + all replies in chronological order, plus
 * a composer that posts as a reply to the same parent.
 *
 * Cache invalidation is already handled by `applyChannelEvent`:
 * `channel:thread:rollup` and `channel:message:created` both invalidate
 * `channelKeys.thread(channelId, parentId)`, so the drawer re-fetches
 * automatically as new replies land.
 */
export function ChannelThreadDrawer({
  channelId,
  parentId,
}: {
  channelId: string;
  parentId: string;
}) {
  const closeThread = useChannelClientStore((s) => s.closeThread);
  const { t } = useT("channels");
  const { data: messages, isLoading } = useQuery(
    channelThreadOptions(channelId, parentId),
  );

  return (
    <aside
      className="w-96 border-l flex flex-col min-w-0"
      data-testid="channel-thread-drawer"
    >
      <header className="border-b px-3 py-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(($) => $.thread_drawer.title)}</h3>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t(($) => $.thread_drawer.close_aria)}
          onClick={() => closeThread(channelId)}
        >
          &times;
        </Button>
      </header>
      <ul
        className="flex-1 overflow-y-auto py-2"
        data-testid="channel-thread-message-list"
      >
        {isLoading ? (
          <li className="px-4 py-6 text-sm text-muted-foreground">{t(($) => $.thread_drawer.loading)}</li>
        ) : !messages || messages.length === 0 ? (
          <li className="px-4 py-6 text-sm text-muted-foreground">
            {t(($) => $.thread_drawer.not_found)}
          </li>
        ) : (
          messages.map((m) => <ChannelMessageRow key={m.id} msg={m} />)
        )}
      </ul>
      <ChannelThinkingIndicator channelId={channelId} parentId={parentId} />
      <ChannelComposer channelId={channelId} parentMessageId={parentId} />
    </aside>
  );
}
