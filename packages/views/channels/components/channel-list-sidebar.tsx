"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@folio/ui/components/ui/button";
import { channelListOptions } from "@folio/core/channels";
import { useWorkspacePaths } from "@folio/core/paths";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { ChannelCreateDialog } from "./channel-create-dialog";

export function ChannelListSidebar({ wsId }: { wsId: string }) {
  const nav = useNavigation();
  const p = useWorkspacePaths();
  const { t } = useT("channels");
  const { data: channels = [], isLoading } = useQuery(channelListOptions(wsId));
  const [creating, setCreating] = useState(false);

  return (
    <div className="px-2 py-3 flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t(($) => $.sidebar.header)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setCreating(true)}
          aria-label={t(($) => $.sidebar.new_aria)}
        >
          +
        </Button>
      </div>
      {isLoading ? (
        // Skeleton bars while the list resolves — three is enough to suggest
        // "real content arriving" without taking over the sidebar height.
        <div className="flex flex-col gap-1 px-2 py-1" aria-busy="true">
          <div className="h-5 w-32 rounded bg-muted animate-pulse" />
          <div className="h-5 w-24 rounded bg-muted animate-pulse" />
          <div className="h-5 w-28 rounded bg-muted animate-pulse" />
        </div>
      ) : channels.length === 0 ? (
        <div
          className="px-2 py-3 text-xs text-muted-foreground flex flex-col gap-2"
          data-testid="channel-list-empty"
        >
          <span>{t(($) => $.sidebar.empty_title)}</span>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onClick={() => setCreating(true)}
          >
            {t(($) => $.sidebar.empty_cta)}
          </Button>
        </div>
      ) : (
        channels.map((c) => (
          <button
            key={c.id}
            onClick={() => nav.push(p.channelDetail(c.id))}
            className="text-left px-2 py-1 rounded hover:bg-accent text-sm truncate"
          >
            {c.kind === "group_dm"
              ? t(($) => $.view.dm_title)
              : `${t(($) => $.view.channel_prefix)} ${c.name ?? t(($) => $.view.unnamed)}`}
          </button>
        ))
      )}
      <ChannelCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => nav.push(p.channelDetail(id))}
      />
    </div>
  );
}
