"use client";

import { useWorkspaceId } from "@folio/core/hooks";
import { useT } from "../../i18n";
import { ChannelListSidebar } from "./channel-list-sidebar";

/**
 * Workspace-scoped channels landing page: sidebar of channels + an empty-state
 * panel prompting the user to pick one. Used as the no-channel-selected route
 * on both web and desktop. Detail routes render `<ChannelView/>` directly.
 */
export function ChannelsListPage() {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  return (
    <div className="flex h-full">
      <aside className="w-64 border-r overflow-y-auto shrink-0">
        <ChannelListSidebar wsId={wsId} />
      </aside>
      <div className="flex-1 grid place-items-center text-muted-foreground">
        {t(($) => $.list_page.select_prompt)}
      </div>
    </div>
  );
}
