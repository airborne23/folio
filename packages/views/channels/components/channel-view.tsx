"use client";

import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@folio/core/hooks";
import {
  channelDetailOptions,
  useChannelClientStore,
} from "@folio/core/channels";
import { Button } from "@folio/ui/components/ui/button";
import { useT } from "../../i18n";
import { ChannelMessageList } from "./channel-message-list";
import { ChannelComposer } from "./channel-composer";
import { ChannelSettingsPanel } from "./channel-settings-panel";
import { ChannelThreadDrawer } from "./channel-thread-drawer";
import { ChannelThinkingIndicator } from "./channel-thinking-indicator";

export function ChannelView({ channelId }: { channelId: string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  const { data: channel, isLoading } = useQuery(
    channelDetailOptions(wsId, channelId),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Open-thread state lives in the channels client store so the active thread
  // is preserved across remounts (sidebar nav, settings toggle, etc.) and
  // restored on reload.
  const openThread = useChannelClientStore(
    (s) => s.openThreadByChannel[channelId] ?? null,
  );
  const setOpenThread = useChannelClientStore((s) => s.openThread);

  return (
    <div className="flex flex-row h-full">
      <div className="flex flex-col flex-1 min-w-0">
        <header className="border-b px-4 py-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {isLoading || !channel ? (
              <div className="h-6 w-48 rounded bg-muted animate-pulse" />
            ) : (
              <>
                <h1 className="text-lg font-semibold">
                  {channel.kind === "group_dm"
                    ? t(($) => $.view.dm_title)
                    : `${t(($) => $.view.channel_prefix)} ${channel.name ?? t(($) => $.view.unnamed)}`}
                </h1>
                {channel.topic && (
                  <p className="text-sm text-muted-foreground mt-0.5">{channel.topic}</p>
                )}
              </>
            )}
          </div>
          <Button
            size="sm"
            variant={settingsOpen ? "secondary" : "ghost"}
            onClick={() => setSettingsOpen((o) => !o)}
          >
            {t(($) => $.view.settings_button)}
          </Button>
        </header>
        <Suspense
          fallback={
            <div className="flex-1 grid place-items-center text-muted-foreground">
              {t(($) => $.view.loading_messages)}
            </div>
          }
        >
          <ChannelMessageList
            channelId={channelId}
            onOpenThread={(parentId) => setOpenThread(channelId, parentId)}
          />
        </Suspense>
        <ChannelThinkingIndicator channelId={channelId} />
        <ChannelComposer channelId={channelId} />
      </div>
      {openThread && (
        <ChannelThreadDrawer channelId={channelId} parentId={openThread} />
      )}
      {settingsOpen && (
        <ChannelSettingsPanel
          channelId={channelId}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
