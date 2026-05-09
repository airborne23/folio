"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, MoreHorizontal, X } from "lucide-react";
import { Button } from "@folio/ui/components/ui/button";
import { Input } from "@folio/ui/components/ui/input";
import { Label } from "@folio/ui/components/ui/label";
import { Separator } from "@folio/ui/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@folio/ui/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@folio/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@folio/ui/components/ui/dropdown-menu";
import {
  channelDetailOptions,
  channelMembersOptions,
  usePatchChannel,
  useUpsertChannelMember,
  useRemoveChannelMember,
  type SubscribeMode,
} from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import { agentListOptions } from "@folio/core/workspace/queries";
import { useActorName } from "@folio/core/workspace/hooks";
import type { ChannelMember } from "@folio/core/types";
import { ChannelAuthorAvatar } from "./channel-author-avatar";
import { useT } from "../../i18n";

export function ChannelSettingsPanel({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  const { data: members = [] } = useQuery(channelMembersOptions(wsId, channelId));
  const upsert = useUpsertChannelMember(channelId);
  const remove = useRemoveChannelMember(channelId);
  const [adding, setAdding] = useState(false);

  return (
    <aside className="w-72 border-l flex flex-col overflow-y-auto bg-background">
      {/* Sticky panel header — title + ✕ close. Sits above everything so a
          long member list still leaves the dismiss affordance reachable. */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur">
        <h2 className="font-serif text-base font-medium tracking-tight">
          {t(($) => $.settings.panel_title) ?? t(($) => $.view.settings_button)}
        </h2>
        <button
          type="button"
          aria-label={t(($) => $.settings.close_aria) ?? "Close"}
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex flex-col gap-3 p-3">
        <ChannelPrefsSection channelId={channelId} />
        <Separator />
        <header className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">{t(($) => $.settings.members_title)}</h2>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            {t(($) => $.settings.add_agent)}
          </Button>
        </header>

        <ul className="flex flex-col">
          {members.map((m) => (
            <ChannelMemberRow
              key={m.id}
              member={m}
              onSetMode={async (mode) => {
                try {
                  await upsert.mutateAsync({
                    memberRef: `agent:${m.member_id}`,
                    subscribe_mode: mode,
                  });
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : t(($) => $.settings.update_failed),
                  );
                }
              }}
              onRemove={async () => {
                try {
                  await remove.mutateAsync(`${m.member_type}:${m.member_id}`);
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : t(($) => $.settings.remove_failed),
                  );
                }
              }}
            />
          ))}
        </ul>

        <AddAgentDialog
          open={adding}
          onOpenChange={setAdding}
          channelId={channelId}
          existingAgentIds={
            new Set(
              members
                .filter((m) => m.member_type === "agent")
                .map((m) => m.member_id),
            )
          }
        />
      </div>
    </aside>
  );
}

/**
 * A single member row in the settings panel. Resolves member_id → real name
 * via useActorName so users see "UI 设计师" instead of "[agent] f1a2b3c4",
 * paints the cyberpunk neon avatar from ChannelAuthorAvatar, and folds the
 * subscribe-mode toggle + remove action into a hover-revealed ⋯ menu so the
 * row stays one line tall in the 72px-wide panel.
 *
 * The current mode shows as an italic serif sub-label (e.g. "全订阅" /
 * "仅 @ 提及") under the name — visible at-a-glance without occupying
 * a Select footprint.
 */
function ChannelMemberRow({
  member,
  onSetMode,
  onRemove,
}: {
  member: ChannelMember;
  onSetMode: (mode: SubscribeMode) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}) {
  const { t } = useT("channels");
  const { getActorName } = useActorName();
  const name = getActorName(member.member_type, member.member_id);
  const mode = member.subscribe_mode ?? "subscribe";
  const modeLabel =
    mode === "mention_only"
      ? t(($) => $.settings.default_mode_mention)
      : t(($) => $.settings.default_mode_subscribe);

  return (
    <li className="group/member flex items-center gap-2.5 rounded-md py-1.5 pl-1 pr-1 hover:bg-accent/50">
      <ChannelAuthorAvatar
        authorId={member.member_id}
        authorName={name}
        isAgent={member.member_type === "agent"}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-tight">{name}</div>
        {member.member_type === "agent" && (
          <div className="mt-0.5 truncate font-serif text-[11px] italic leading-tight text-muted-foreground">
            {modeLabel}
          </div>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t(($) => $.settings.row_menu_aria) ?? "Member actions"}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/member:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100 data-popup-open:bg-accent data-popup-open:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-44">
          {member.member_type === "agent" && (
            <>
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {t(($) => $.settings.subscribe_mode_aria)}
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onSetMode("subscribe")}>
                {mode === "subscribe" && <Check className="size-3.5" />}
                <span className={mode === "subscribe" ? "" : "ml-[1.125rem]"}>
                  {t(($) => $.settings.default_mode_subscribe)}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSetMode("mention_only")}>
                {mode === "mention_only" && <Check className="size-3.5" />}
                <span className={mode === "mention_only" ? "" : "ml-[1.125rem]"}>
                  {t(($) => $.settings.default_mode_mention)}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            {t(($) => $.settings.remove_action) ?? "Remove"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// ChannelPrefsSection edits the channel-wide gate config: default subscribe
// mode, agent cooldown (seconds in the UI, ms on the wire), and max
// consecutive agent turns. Changes are buffered locally and saved together —
// per-field optimistic patches would race when the user is still editing.
function ChannelPrefsSection({ channelId }: { channelId: string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  const { data: channel } = useQuery(channelDetailOptions(wsId, channelId));
  const patch = usePatchChannel(channelId);

  const [defaultMode, setDefaultMode] = useState<SubscribeMode>("subscribe");
  const [cooldownSec, setCooldownSec] = useState<string>("30");
  const [maxTurns, setMaxTurns] = useState<string>("5");

  // Sync local state with server state on first load and after a save.
  useEffect(() => {
    if (!channel) return;
    setDefaultMode(channel.default_subscribe_mode);
    setCooldownSec(String(Math.round(channel.agent_cooldown_ms / 1000)));
    setMaxTurns(String(channel.max_consecutive_agent_turns));
  }, [channel]);

  if (!channel) {
    return (
      <div className="flex flex-col gap-2">
        <div className="h-3 w-20 rounded bg-muted animate-pulse" />
        <div className="h-8 rounded bg-muted animate-pulse" />
      </div>
    );
  }

  const dirty =
    defaultMode !== channel.default_subscribe_mode ||
    Number(cooldownSec) * 1000 !== channel.agent_cooldown_ms ||
    Number(maxTurns) !== channel.max_consecutive_agent_turns;

  const onSave = async () => {
    const cd = Number(cooldownSec);
    const mt = Number(maxTurns);
    if (!Number.isFinite(cd) || cd < 0) {
      toast.error(t(($) => $.settings.validation.cooldown_negative));
      return;
    }
    if (!Number.isFinite(mt) || mt < 1) {
      toast.error(t(($) => $.settings.validation.turns_min));
      return;
    }
    try {
      await patch.mutateAsync({
        default_subscribe_mode: defaultMode,
        agent_cooldown_ms: Math.round(cd * 1000),
        max_consecutive_agent_turns: Math.round(mt),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.settings.save_failed));
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold text-sm">{t(($) => $.settings.preferences_title)}</h2>

      <div className="flex flex-col gap-1">
        <Label htmlFor="ch-default-mode" className="text-xs">
          {t(($) => $.settings.default_mode_label)}
        </Label>
        <Select
          value={defaultMode}
          onValueChange={(v) => setDefaultMode(v as SubscribeMode)}
        >
          <SelectTrigger id="ch-default-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mention_only">{t(($) => $.settings.default_mode_mention)}</SelectItem>
            <SelectItem value="subscribe">{t(($) => $.settings.default_mode_subscribe)}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="ch-cooldown" className="text-xs">
          {t(($) => $.settings.cooldown_label)}
        </Label>
        <Input
          id="ch-cooldown"
          type="number"
          min={0}
          step={1}
          value={cooldownSec}
          onChange={(e) => setCooldownSec(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="ch-max-turns" className="text-xs">
          {t(($) => $.settings.max_turns_label)}
        </Label>
        <Input
          id="ch-max-turns"
          type="number"
          min={1}
          step={1}
          value={maxTurns}
          onChange={(e) => setMaxTurns(e.target.value)}
        />
      </div>

      <Button
        size="sm"
        variant="secondary"
        onClick={onSave}
        disabled={!dirty || patch.isPending}
      >
        {patch.isPending ? t(($) => $.settings.saving) : t(($) => $.settings.save)}
      </Button>
    </section>
  );
}

function AddAgentDialog({
  open,
  onOpenChange,
  channelId,
  existingAgentIds,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channelId: string;
  existingAgentIds: Set<string>;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("channels");
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const upsert = useUpsertChannelMember(channelId);
  // Drop archived agents — they can't run, so adding them produces a
  // dead-weight channel_member row. Every other agent picker in the codebase
  // (agent-picker.tsx, runtime-detail.tsx, member-profile-card.tsx) applies
  // the same filter; agentListOptions returns the unfiltered list.
  const candidates = agents.filter((a) => !a.archived_at && !existingAgentIds.has(a.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.settings.add_agent_dialog_title)}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto">
          {candidates.length === 0 ? (
            <li className="text-sm text-muted-foreground p-2">
              {t(($) => $.settings.no_more_agents)}
            </li>
          ) : (
            candidates.map((a) => (
              <li key={a.id}>
                <button
                  className="w-full text-left p-2 rounded hover:bg-accent text-sm"
                  onClick={async () => {
                    try {
                      await upsert.mutateAsync({ memberRef: `agent:${a.id}` });
                      onOpenChange(false);
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : t(($) => $.settings.add_failed),
                      );
                    }
                  }}
                >
                  {a.name}
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
