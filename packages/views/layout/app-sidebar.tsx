"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@folio/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Inbox,
  ClipboardList,
  BrainCircuit,
  Cpu,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  LogOut,
  Plus,
  Check,
  GraduationCap,
  SquarePen,
  CircleUser,
  Layers,
  Hash,
  X,
  Sparkles,
} from "lucide-react";
import { WorkspaceAvatar } from "../workspace/workspace-avatar";
import { ActorAvatar } from "@folio/ui/components/common/actor-avatar";
import { ActorAvatar as SmartActorAvatar } from "../common/actor-avatar";
import { FolioIcon } from "@folio/ui/components/common/folio-icon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@folio/ui/components/ui/tooltip";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@folio/ui/components/ui/collapsible";
import { StatusIcon } from "../issues/components/status-icon";
import { useIssueDraftStore } from "@folio/core/issues/stores/draft-store";
import { useCreateModeStore } from "@folio/core/issues/stores/create-mode-store";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@folio/ui/components/ui/sidebar";
import { useSidebarExpansionStore } from "@folio/core/layout";
import { channelListOptions } from "@folio/core/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import { projectListOptions } from "@folio/core/projects/queries";
import { autopilotListOptions } from "@folio/core/autopilots/queries";
import { agentListOptions } from "@folio/core/workspace/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@folio/ui/components/ui/dropdown-menu";
import { useAuthStore } from "@folio/core/auth";
import { useCurrentWorkspace, useWorkspacePaths, paths } from "@folio/core/paths";
import { workspaceListOptions, myInvitationListOptions, workspaceKeys } from "@folio/core/workspace/queries";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { inboxKeys, deduplicateInboxItems } from "@folio/core/inbox/queries";
import { api, ApiError } from "@folio/core/api";
import { useModalStore } from "@folio/core/modals";
import { useMyRuntimesNeedUpdate } from "@folio/core/runtimes/hooks";
import { pinListOptions } from "@folio/core/pins/queries";
import { useDeletePin, useReorderPins } from "@folio/core/pins/mutations";
import { issueDetailOptions } from "@folio/core/issues/queries";
import { projectDetailOptions } from "@folio/core/projects/queries";
import type { PinnedItem } from "@folio/core/types";
import { useLogout } from "../auth";
import { ProjectIcon } from "../projects/components/project-icon";
import { useT } from "../i18n";

// Top-level nav items stay active when the user is on a child route
// (e.g. "Projects" stays lit on /:slug/projects/:id). Pinned items keep
// strict equality elsewhere — a pinned project shouldn't highlight on
// sub-pages of itself.
function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

// Stable empty arrays for query defaults. Using an inline `= []` default on
// `useQuery` creates a new array reference on every render when `data` is
// undefined (e.g. query disabled or loading) — which in turn breaks any
// `useEffect`/`useMemo` that depends on the value, and can trigger infinite
// re-render loops when the effect itself calls `setState`.
const EMPTY_PINS: PinnedItem[] = [];
const EMPTY_WORKSPACES: Awaited<ReturnType<typeof api.listWorkspaces>> = [];
const EMPTY_INVITATIONS: Awaited<ReturnType<typeof api.listMyInvitations>> = [];
const EMPTY_INBOX: Awaited<ReturnType<typeof api.listInbox>> = [];

// Nav items reference WorkspacePaths method names so they can be resolved
// against the current workspace slug at render time (see AppSidebar body).
// Only parameterless paths are valid nav destinations.
type NavKey =
  | "inbox"
  | "myIssues"
  | "issues"
  | "projects"
  | "autopilots"
  | "agents"
  | "channels"
  | "runtimes"
  | "skills"
  | "settings";

// Static schema (key + icon) — labels resolved at render via useT("layout").
type NavLabelKey =
  | "inbox"
  | "my_issues"
  | "issues"
  | "projects"
  | "autopilots"
  | "agents"
  | "channels"
  | "runtimes"
  | "skills"
  | "settings";

// Dopamine icon palette — each nav slot gets a distinct candy hue so the
// sidebar reads as a colour-coded shelf rather than a row of grey marks.
// Colours are chosen for cream-canvas legibility (avoiding pastel washes
// that disappear) and for emotional read (warm = personal/active flow,
// cool = system/configure flow).
//
// `iconClass` carries the Tailwind arbitrary text-[hex] that paints the
// SVG; it persists across hover / active states because the primitive no
// longer overrides icon colour. The active row's caramel left-bar +
// deeper bg are enough to mark "you are here" without recolouring the
// icon.
type NavConfig = {
  key: NavKey;
  labelKey: NavLabelKey;
  icon: typeof Inbox;
  iconClass: string;
};

const personalNav: NavConfig[] = [
  { key: "inbox", labelKey: "inbox", icon: Inbox, iconClass: "text-[#4FA8FF]" },
  { key: "myIssues", labelKey: "my_issues", icon: CircleUser, iconClass: "text-[#B388FF]" },
];

const workspaceNav: NavConfig[] = [
  { key: "issues", labelKey: "issues", icon: ClipboardList, iconClass: "text-[#FF8B3D]" },
  { key: "channels", labelKey: "channels", icon: Hash, iconClass: "text-[#FF7AA8]" },
  { key: "projects", labelKey: "projects", icon: Layers, iconClass: "text-[#34C49E]" },
  { key: "autopilots", labelKey: "autopilots", icon: Sparkles, iconClass: "text-[#F4C430]" },
  { key: "agents", labelKey: "agents", icon: BrainCircuit, iconClass: "text-[#C77DFF]" },
];

const configureNav: NavConfig[] = [
  { key: "runtimes", labelKey: "runtimes", icon: Cpu, iconClass: "text-[#2DD4BF]" },
  { key: "skills", labelKey: "skills", icon: GraduationCap, iconClass: "text-[#FF8E80]" },
  { key: "settings", labelKey: "settings", icon: SlidersHorizontal, iconClass: "text-[#6B82FF]" },
];

// Editorial chapter markers for nav items. Each group restarts at i. so the
// numbering reads like a magazine table-of-contents per section, not a flat
// global index. Rendered with very low opacity so they decorate without
// competing with the icon for scan attention.
const ROMAN_NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii"] as const;

function NavNumeral({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className="inline-block w-4 shrink-0 text-right pr-0.5 font-serif italic text-[11px] leading-none text-sidebar-foreground/30 group-data-[collapsible=icon]:hidden"
    >
      {ROMAN_NUMERALS[index] ?? index + 1}.
    </span>
  );
}

function DraftDot() {
  const hasDraft = useIssueDraftStore((s) => !!(s.draft.title || s.draft.description));
  if (!hasDraft) return null;
  return <span className="absolute top-0 right-0 size-1.5 rounded-full bg-brand" />;
}

/**
 * Presentational pin row. The `label` and `iconNode` are computed by the
 * parent `PinRow` from cached issue / project detail queries — keeping
 * this component dumb means the dnd-kit / navigation wiring lives in
 * one place and the data flow is explicit.
 */
function SortablePinItem({
  pin,
  href,
  pathname,
  onUnpin,
  label,
  iconNode,
}: {
  pin: PinnedItem;
  href: string;
  pathname: string;
  onUnpin: () => void;
  label: string;
  iconNode: React.ReactNode;
}) {
  const { t } = useT("layout");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pin.id });
  const wasDragged = useRef(false);

  useEffect(() => {
    if (isDragging) wasDragged.current = true;
  }, [isDragging]);

  const style = { transform: CSS.Transform.toString(transform), transition };
  const isActive = pathname === href;

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={style}
      className={cn("group/pin", isDragging && "opacity-30")}
      {...attributes}
      {...listeners}
    >
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        render={<AppLink href={href} draggable={false} />}
        onClick={(event) => {
          if (wasDragged.current) {
            wasDragged.current = false;
            event.preventDefault();
            return;
          }
        }}
        className={cn(
          "text-muted-foreground",
          isDragging && "pointer-events-none",
        )}
      >
        {iconNode}
        <span
          className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
          style={{
            maskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
          }}
        >{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={<span role="button" />}
            className="hidden size-2.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover/pin:flex hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnpin();
            }}
          >
            <X className="size-1" />
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>{t(($) => $.sidebar.unpin_tooltip)}</TooltipContent>
        </Tooltip>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Smart wrapper that resolves a pin's display data (label + status/icon)
 * from the issue / project detail query cache. Both queries are declared
 * unconditionally with `enabled` gates so the hook order stays stable
 * regardless of `pin.item_type`.
 *
 * Loading: render a flat skeleton so the sidebar height doesn't jump.
 * Missing (deleted item / 404): render nothing — the row hides itself
 * until the user unpins manually or a server-side cascade catches up.
 */
function PinRow({
  pin,
  href,
  pathname,
  onUnpin,
  wsId,
}: {
  pin: PinnedItem;
  href: string;
  pathname: string;
  onUnpin: () => void;
  wsId: string;
}) {
  const isIssue = pin.item_type === "issue";
  const issueQuery = useQuery({
    ...issueDetailOptions(wsId, pin.item_id),
    enabled: isIssue,
  });
  const projectQuery = useQuery({
    ...projectDetailOptions(wsId, pin.item_id),
    enabled: !isIssue,
  });

  const triggeredRef = useRef(false);
  useEffect(() => {
    const err = isIssue ? issueQuery.error : projectQuery.error;
    if (err instanceof ApiError && err.status === 404 && !triggeredRef.current) {
      triggeredRef.current = true;
      onUnpin();
    }
  }, [isIssue, issueQuery.error, onUnpin, projectQuery.error]);

  if (isIssue) {
    if (issueQuery.isPending) return <PinSkeleton />;
    if (issueQuery.isError || !issueQuery.data) return null;
    const issue = issueQuery.data;
    const label = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
    const iconNode = (
      /* Override parent [&_svg]:size-4 — pinned items need smaller icons to match sm size */
      <StatusIcon status={issue.status} className="!size-3.5 shrink-0" />
    );
    return (
      <SortablePinItem
        pin={pin}
        href={href}
        pathname={pathname}
        onUnpin={onUnpin}
        label={label}
        iconNode={iconNode}
      />
    );
  }

  if (projectQuery.isPending) return <PinSkeleton />;
  if (projectQuery.isError || !projectQuery.data) return null;
  const project = projectQuery.data;
  const iconNode = <ProjectIcon project={project} size="sm" />;
  return (
    <SortablePinItem
      pin={pin}
      href={href}
      pathname={pathname}
      onUnpin={onUnpin}
      label={project.title}
      iconNode={iconNode}
    />
  );
}

function PinSkeleton() {
  return (
    <SidebarMenuItem>
      <div className="flex h-7 w-full items-center gap-2 px-2">
        <div className="size-3.5 shrink-0 rounded-sm bg-sidebar-accent/40" />
        <div className="h-3 w-24 rounded bg-sidebar-accent/40" />
      </div>
    </SidebarMenuItem>
  );
}

interface AppSidebarProps {
  /** Rendered above SidebarHeader (e.g. desktop traffic light spacer) */
  topSlot?: React.ReactNode;
  /** Rendered in the header between workspace switcher and new-issue button (e.g. search trigger) */
  searchSlot?: React.ReactNode;
  /** Extra className for SidebarHeader */
  headerClassName?: string;
  /** Extra style for SidebarHeader */
  headerStyle?: React.CSSProperties;
}

export function AppSidebar({ topSlot, searchSlot, headerClassName, headerStyle }: AppSidebarProps = {}) {
  const { t } = useT("layout");
  const { pathname, push } = useNavigation();
  const user = useAuthStore((s) => s.user);
  const userId = useAuthStore((s) => s.user?.id);
  const logout = useLogout();
  const workspace = useCurrentWorkspace();
  const p = useWorkspacePaths();
  const { data: workspaces = EMPTY_WORKSPACES } = useQuery(workspaceListOptions());
  const { data: myInvitations = EMPTY_INVITATIONS } = useQuery(myInvitationListOptions());

  const wsId = workspace?.id;
  const { data: inboxItems = EMPTY_INBOX } = useQuery({
    queryKey: wsId ? inboxKeys.list(wsId) : ["inbox", "disabled"],
    queryFn: () => api.listInbox(),
    enabled: !!wsId,
  });
  const unreadCount = React.useMemo(
    () => deduplicateInboxItems(inboxItems).filter((i) => !i.read).length,
    [inboxItems],
  );
  const hasRuntimeUpdates = useMyRuntimesNeedUpdate(wsId);
  const { data: pinnedItems = EMPTY_PINS } = useQuery({
    ...pinListOptions(wsId ?? "", userId ?? ""),
    enabled: !!wsId && !!userId,
  });
  const deletePin = useDeletePin();
  const reorderPins = useReorderPins();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Local presentational copy of pinnedItems for drop-animation stability.
  // Follows TQ at rest; frozen during a drag gesture so a mid-drag cache
  // write (our own optimistic update, or a WS refetch) cannot reorder the
  // DOM under dnd-kit while its drop animation is still interpolating.
  const [localPinned, setLocalPinned] = useState<PinnedItem[]>(pinnedItems);
  const isDraggingRef = useRef(false);
  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalPinned(pinnedItems);
    }
  }, [pinnedItems]);

  const handleDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = localPinned.findIndex((p) => p.id === active.id);
      const newIndex = localPinned.findIndex((p) => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(localPinned, oldIndex, newIndex);
      setLocalPinned(reordered);
      reorderPins.mutate(reordered);
    },
    [localPinned, reorderPins],
  );

  const queryClient = useQueryClient();
  const acceptInvitationMut = useMutation({
    mutationFn: (id: string) => api.acceptInvitation(id),
    // After accepting an invitation, navigate INTO the newly-joined workspace.
    // Otherwise the user stays on their current workspace and just sees the
    // new one appear in the dropdown — silent and confusing (this is MUL-820).
    onSuccess: async (_, invitationId) => {
      const invitation = myInvitations.find((i) => i.id === invitationId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
      // staleTime: 0 forces a real network fetch — we need the joined workspace
      // in the list before we can resolve its slug for navigation.
      const list = await queryClient.fetchQuery({
        ...workspaceListOptions(),
        staleTime: 0,
      });
      const joined = invitation
        ? list.find((w) => w.id === invitation.workspace_id)
        : null;
      if (joined) {
        push(paths.workspace(joined.slug).issues());
      }
    },
  });
  const declineInvitationMut = useMutation({
    mutationFn: (id: string) => api.declineInvitation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
    },
  });

  // Global "C" shortcut: opens whichever create mode the user landed on last
  // (agent vs manual), persisted in useCreateModeStore. The mode switch lives
  // inside both modal footers so users can flip without remembering which
  // shortcut goes where — `c` always means "open the create flow I prefer".
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (isEditable) return;
      if (useModalStore.getState().modal) return;
      e.preventDefault();
      const lastMode = useCreateModeStore.getState().lastMode;
      if (lastMode === "manual") {
        // Auto-fill project when on a project detail page (manual form only —
        // agent mode lets the agent infer project from the prompt).
        const projectMatch = pathname.match(/^\/[^/]+\/projects\/([^/]+)$/);
        const data = projectMatch ? { project_id: projectMatch[1] } : undefined;
        useModalStore.getState().open("create-issue", data);
      } else {
        useModalStore.getState().open("quick-create-issue");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pathname]);

  return (
      <Sidebar variant="inset">
        {topSlot}
        {/* Editorial brand row — folio open-spread mark + serif wordmark.
            FolioIcon renders the two-page spread + caramel spine glyph
            (matches favicon / docs logo), wordmark uses Source Serif 4
            so the lockup reads as "an open book leaf" on the editorial
            margin column. group-data-[collapsible=icon] hides the
            wordmark when the sidebar collapses to icon-only. */}
        <SidebarHeader className={cn("py-3", headerClassName)} style={headerStyle}>
          <div className="flex items-center gap-2 px-2 pb-1">
            <FolioIcon className="text-2xl" />
            <span className="font-serif text-xl font-semibold tracking-tight text-foreground group-data-[collapsible=icon]:hidden">
              folio
            </span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton>
                      <span className="relative">
                        <WorkspaceAvatar name={workspace?.name ?? "M"} size="sm" />
                        {myInvitations.length > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-brand ring-1 ring-sidebar" />
                        )}
                      </span>
                      <span className="flex-1 truncate">
                        {workspace?.name ?? "Folio"}
                      </span>
                      <ChevronDown className="size-3 text-muted-foreground" />
                    </SidebarMenuButton>
                  }
                />
                <DropdownMenuContent
                  className="w-auto min-w-56"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                >
                  <div className="flex items-center gap-2.5 px-2 py-1.5">
                    <ActorAvatar
                      name={user?.name ?? ""}
                      initials={(user?.name ?? "U").charAt(0).toUpperCase()}
                      avatarUrl={user?.avatar_url}
                      size={32}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">
                        {user?.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground leading-tight">
                        {user?.email}
                      </p>
                    </div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t(($) => $.sidebar.workspaces_label)}
                    </DropdownMenuLabel>
                    {workspaces.map((ws) => (
                      <DropdownMenuItem
                        key={ws.id}
                        render={
                          <AppLink href={paths.workspace(ws.slug).issues()} />
                        }
                      >
                        <WorkspaceAvatar name={ws.name} size="sm" />
                        <span className="flex-1 truncate">{ws.name}</span>
                        {ws.id === workspace?.id && (
                          <Check className="h-3.5 w-3.5 text-primary" />
                        )}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem
                      onClick={() =>
                        useModalStore.getState().open("create-workspace")
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t(($) => $.sidebar.create_workspace)}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  {myInvitations.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                          {t(($) => $.sidebar.pending_invitations_label)}
                        </DropdownMenuLabel>
                        {myInvitations.map((inv) => (
                          <div key={inv.id} className="flex items-center gap-2 px-2 py-1.5">
                            <WorkspaceAvatar name={inv.workspace_name ?? "W"} size="sm" />
                            <span className="flex-1 truncate text-sm">{inv.workspace_name ?? t(($) => $.sidebar.invitation_workspace_fallback)}</span>
                            <button
                              type="button"
                              className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                              disabled={acceptInvitationMut.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                acceptInvitationMut.mutate(inv.id);
                              }}
                            >
                              {t(($) => $.sidebar.invitation_join)}
                            </button>
                            <button
                              type="button"
                              className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
                              disabled={declineInvitationMut.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                declineInvitationMut.mutate(inv.id);
                              }}
                            >
                              {t(($) => $.sidebar.invitation_decline)}
                            </button>
                          </div>
                        ))}
                      </DropdownMenuGroup>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" onClick={logout}>
                      <LogOut className="h-3.5 w-3.5" />
                      {t(($) => $.sidebar.log_out)}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarMenu>
            {searchSlot && (
              <SidebarMenuItem>
                {searchSlot}
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-muted-foreground"
                onClick={() => useModalStore.getState().open("quick-create-issue")}
              >
                <span className="relative">
                  <SquarePen />
                  <DraftDot />
                </span>
                <span>{t(($) => $.sidebar.new_issue)}</span>
                <kbd className="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">{t(($) => $.sidebar.new_issue_shortcut)}</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        {/* Navigation */}
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {personalNav.map((item, idx) => {
                  const href = p[item.key]();
                  const isActive = isNavActive(pathname, href);
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isActive}
                        render={<AppLink href={href} />}
                        className="text-muted-foreground"
                      >
                        <NavNumeral index={idx} />
                        <item.icon className={item.iconClass} />
                        <span>{t(($) => $.nav[item.labelKey])}</span>
                        {item.key === "inbox" && unreadCount > 0 && (
                          <span className="ml-auto text-xs">
                            {unreadCount > 99 ? "99+" : unreadCount}
                          </span>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {localPinned.length > 0 && (
            <Collapsible defaultOpen>
              <SidebarGroup className="group/pinned">
                <SidebarGroupLabel
                  render={<CollapsibleTrigger />}
                  className="group/trigger cursor-pointer hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
                >
                  <span>{t(($) => $.sidebar.pinned_label)}</span>
                  <ChevronRight className="!size-3 ml-1 stroke-[2.5] transition-transform duration-200 group-data-[panel-open]/trigger:rotate-90" />
                  <span className="ml-auto text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/pinned:opacity-100">{localPinned.length}</span>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                      <SortableContext items={localPinned.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                        <SidebarMenu className="gap-0.5">
                          {localPinned.map((pin: PinnedItem) => (
                            <PinRow
                              key={pin.id}
                              pin={pin}
                              href={pin.item_type === "issue" ? p.issueDetail(pin.item_id) : p.projectDetail(pin.item_id)}
                              pathname={pathname}
                              onUnpin={() => deletePin.mutate({ itemType: pin.item_type, itemId: pin.item_id })}
                              wsId={wsId ?? ""}
                            />
                          ))}
                        </SidebarMenu>
                      </SortableContext>
                    </DndContext>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          )}

          <SidebarGroup>
            <SidebarGroupLabel>{t(($) => $.sidebar.workspace_group)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {workspaceNav.map((item, idx) => {
                  // Items with browseable children get the tree-expand
                  // treatment: parent button toggles in-place, no jump
                  // to a list page that just shows the same items.
                  // `issues` deliberately stays a flat link — its surface
                  // is filters / boards, not a flat list.
                  if (item.key === "channels") {
                    return <ChannelsNavSection key={item.key} item={item} numeralIndex={idx} />;
                  }
                  if (item.key === "projects") {
                    return <ProjectsNavSection key={item.key} item={item} numeralIndex={idx} />;
                  }
                  if (item.key === "autopilots") {
                    return <AutopilotsNavSection key={item.key} item={item} numeralIndex={idx} />;
                  }
                  if (item.key === "agents") {
                    return <AgentsNavSection key={item.key} item={item} numeralIndex={idx} />;
                  }
                  const href = p[item.key]();
                  const isActive = isNavActive(pathname, href);
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isActive}
                        render={<AppLink href={href} />}
                        className="text-muted-foreground"
                      >
                        <NavNumeral index={idx} />
                        <item.icon className={item.iconClass} />
                        <span>{t(($) => $.nav[item.labelKey])}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>{t(($) => $.sidebar.configure_group)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {configureNav.map((item, idx) => {
                  const href = p[item.key]();
                  const isActive = isNavActive(pathname, href);
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isActive}
                        render={<AppLink href={href} />}
                        className="text-muted-foreground"
                      >
                        <NavNumeral index={idx} />
                        <item.icon className={item.iconClass} />
                        <span>{t(($) => $.nav[item.labelKey])}</span>
                        {item.key === "runtimes" && hasRuntimeUpdates && (
                          <span className="ml-auto size-1.5 rounded-full bg-destructive" />
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarRail />
      </Sidebar>
  );
}

// Tree-expand pattern shared by every workspace-nav item that has
// browseable children (channels / projects / autopilots / agents). The
// parent button toggles in-place — it deliberately does NOT navigate, so
// users go from "where do I find things?" to "everything's right here"
// in one click. `issues` stays a flat link because its surface is
// filters / boards, not a flat list.
//
// `useChildren(wsId, enabled)` MUST call its hook unconditionally per
// React's rules-of-hooks; the consumer controls `enabled` so the actual
// fetch is skipped until the section is open. `renderChild` returns the
// per-item label + href, isolating section-specific concerns (group_dm
// in channels, archived agents, etc.) from this layout shell.
interface ExpandableNavChild {
  id: string;
  label: string;
  href: string;
  /**
   * Optional element rendered before the label (typically an avatar,
   * project icon, or status dot). Sections that don't supply one fall
   * back to plain label-only rows.
   */
  leading?: React.ReactNode;
}

function ExpandableNavSection<T>({
  sectionId,
  item,
  sectionHref,
  emptyHint,
  createLabel,
  numeralIndex,
  useChildren,
  renderChild,
}: {
  sectionId: string;
  item: { key: NavKey; labelKey: NavLabelKey; icon: typeof Hash; iconClass: string };
  sectionHref: string;
  emptyHint: string;
  /** Aria/tooltip label for the inline `+` button — section-specific so
   *  screen readers say "New channel" not "New". */
  createLabel: string;
  /** Position within the parent nav group, used to render the editorial
   *  `i. ii. iii.` chapter marker before the icon. */
  numeralIndex: number;
  useChildren: (wsId: string, enabled: boolean) => readonly T[];
  renderChild: (child: T) => ExpandableNavChild | null;
}) {
  const { t } = useT("layout");
  const { pathname } = useNavigation();
  const wsId = useWorkspaceId();
  const expandedFlag = useSidebarExpansionStore(
    (s: ReturnType<typeof useSidebarExpansionStore.getState>) => s.expanded[sectionId],
  );
  const toggle = useSidebarExpansionStore(
    (s: ReturnType<typeof useSidebarExpansionStore.getState>) => s.toggle,
  );
  const isExpanded = expandedFlag ?? false;
  const rawChildren = useChildren(wsId, isExpanded);
  const children = rawChildren
    .map(renderChild)
    .filter((c): c is ExpandableNavChild => c !== null);

  // Active when the user is anywhere under this nav segment AND the tree
  // is closed; once open, the active highlight moves to the matching
  // child so the parent doesn't double-up the visual.
  const isOnSectionRoute = isNavActive(pathname, sectionHref);

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          // Plain button — toggles only. aria-expanded for SR announce.
          aria-expanded={isExpanded}
          isActive={isOnSectionRoute && !isExpanded}
          onClick={() => toggle(sectionId)}
          className="text-muted-foreground"
        >
          <NavNumeral index={numeralIndex} />
          <item.icon className={item.iconClass} />
          <span>{t(($) => $.nav[item.labelKey])}</span>
          <ChevronRight
            className={cn(
              // Reserve room on the right for the +-action so the chevron
              // doesn't sit under it on hover. mr-5 = 20px, matches the
              // SidebarMenuAction's w-5 footprint.
              "ml-auto mr-5 size-3 transition-transform duration-150",
              isExpanded && "rotate-90",
            )}
          />
        </SidebarMenuButton>
        {/* Inline + action: hover-revealed, doesn't toggle the parent's
            expand state. Navigates to the section's existing list page
            where the Create dialog lives — keeps the empty-state path
            (no children → can't toggle into anything) recoverable.
            showOnHover dims it normally; aria-label gives SR users the
            section-specific verb. */}
        <SidebarMenuAction
          showOnHover
          aria-label={createLabel}
          title={createLabel}
          render={<AppLink href={sectionHref} />}
        >
          <Plus />
        </SidebarMenuAction>
      </SidebarMenuItem>
      {isExpanded && (
        <SidebarMenuSub>
          {children.length === 0 ? (
            // Clickable empty state: even with the inline + above, an
            // explicit "Create one" affordance inside the expanded tree
            // makes the path obvious to first-time users who just opened
            // an empty section.
            <li>
              <SidebarMenuSubButton render={<AppLink href={sectionHref} />}>
                <Plus className="size-3" />
                <span className="truncate text-muted-foreground italic">
                  {emptyHint}
                </span>
              </SidebarMenuSubButton>
            </li>
          ) : (
            children.map((c) => (
              <SidebarMenuSubItem key={c.id}>
                <SidebarMenuSubButton
                  isActive={isNavActive(pathname, c.href)}
                  render={<AppLink href={c.href} />}
                >
                  {c.leading}
                  <span className="truncate">{c.label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))
          )}
        </SidebarMenuSub>
      )}
    </>
  );
}

function ChannelsNavSection({
  item,
  numeralIndex,
}: {
  item: { key: NavKey; labelKey: NavLabelKey; icon: typeof Hash; iconClass: string };
  numeralIndex: number;
}) {
  const p = useWorkspacePaths();
  const { t } = useT("layout");
  const channels = useT("channels");
  return (
    <ExpandableNavSection
      sectionId="channels"
      item={item}
      sectionHref={p.channels()}
      emptyHint={t(($) => $.nav_create.channels)}
      createLabel={t(($) => $.nav_create.channels)}
      numeralIndex={numeralIndex}
      useChildren={(wsId, enabled) => {
        const { data = [] } = useQuery({ ...channelListOptions(wsId), enabled });
        return data;
      }}
      renderChild={(c) => {
        const label =
          c.kind === "group_dm"
            ? channels.t(($) => $.view.dm_title)
            : `${channels.t(($) => $.view.channel_prefix)} ${
                c.name ?? channels.t(($) => $.view.unnamed)
              }`;
        return { id: c.id, label, href: p.channelDetail(c.id) };
      }}
    />
  );
}

function ProjectsNavSection({
  item,
  numeralIndex,
}: {
  item: { key: NavKey; labelKey: NavLabelKey; icon: typeof Hash; iconClass: string };
  numeralIndex: number;
}) {
  const p = useWorkspacePaths();
  const { t } = useT("layout");
  return (
    <ExpandableNavSection
      sectionId="projects"
      item={item}
      sectionHref={p.projects()}
      emptyHint={t(($) => $.nav_create.projects)}
      createLabel={t(($) => $.nav_create.projects)}
      numeralIndex={numeralIndex}
      useChildren={(wsId, enabled) => {
        const { data = [] } = useQuery({ ...projectListOptions(wsId), enabled });
        return data;
      }}
      renderChild={(proj) => ({
        id: proj.id,
        label: proj.title,
        href: p.projectDetail(proj.id),
      })}
    />
  );
}

function AutopilotsNavSection({
  item,
  numeralIndex,
}: {
  item: { key: NavKey; labelKey: NavLabelKey; icon: typeof Hash; iconClass: string };
  numeralIndex: number;
}) {
  const p = useWorkspacePaths();
  const { t } = useT("layout");
  return (
    <ExpandableNavSection
      sectionId="autopilots"
      item={item}
      sectionHref={p.autopilots()}
      emptyHint={t(($) => $.nav_create.autopilots)}
      createLabel={t(($) => $.nav_create.autopilots)}
      numeralIndex={numeralIndex}
      useChildren={(wsId, enabled) => {
        const { data = [] } = useQuery({
          ...autopilotListOptions(wsId),
          enabled,
        });
        return data;
      }}
      renderChild={(a) => ({
        id: a.id,
        label: a.title,
        href: p.autopilotDetail(a.id),
      })}
    />
  );
}

function AgentsNavSection({
  item,
  numeralIndex,
}: {
  item: { key: NavKey; labelKey: NavLabelKey; icon: typeof Hash; iconClass: string };
  numeralIndex: number;
}) {
  const p = useWorkspacePaths();
  const { t } = useT("layout");
  return (
    <ExpandableNavSection
      sectionId="agents"
      item={item}
      sectionHref={p.agents()}
      emptyHint={t(($) => $.nav_create.agents)}
      createLabel={t(($) => $.nav_create.agents)}
      numeralIndex={numeralIndex}
      useChildren={(wsId, enabled) => {
        const { data = [] } = useQuery({ ...agentListOptions(wsId), enabled });
        // Hide archived agents — same filter every other agent picker
        // applies; they're dead weight in a quick-jump list.
        return data.filter((a) => !a.archived_at);
      }}
      renderChild={(a) => ({
        id: a.id,
        label: a.name,
        href: p.agentDetail(a.id),
        leading: (
          <SmartActorAvatar
            actorType="agent"
            actorId={a.id}
            size={18}
            className="rounded-full"
          />
        ),
      })}
    />
  );
}
