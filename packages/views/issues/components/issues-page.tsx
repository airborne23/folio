"use client";

import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { ChevronRight, ListTodo } from "lucide-react";
import type { IssueStatus } from "@folio/core/types";
import { Skeleton } from "@folio/ui/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useIssueViewStore, useClearFiltersOnWorkspaceChange } from "@folio/core/issues/stores/view-store";
import { useIssuesScopeStore } from "@folio/core/issues/stores/issues-scope-store";
import { ViewStoreProvider } from "@folio/core/issues/stores/view-store-context";
import { filterIssues } from "../utils/filter";
import { BOARD_STATUSES } from "@folio/core/issues/config";
import { useCurrentWorkspace } from "@folio/core/paths";
import { WorkspaceAvatar } from "../../workspace/workspace-avatar";
import { useWorkspaceId } from "@folio/core/hooks";
import { issueListOptions, childIssueProgressOptions } from "@folio/core/issues/queries";
import { useUpdateIssue } from "@folio/core/issues/mutations";
import { useIssueSelectionStore } from "@folio/core/issues/stores/selection-store";
import { PageHeader } from "../../layout/page-header";
import { IssuesHeader } from "./issues-header";
import { BoardView } from "./board-view";
import { ListView } from "./list-view";
import { BatchActionToolbar } from "./batch-action-toolbar";
import { useT } from "../../i18n";

export function IssuesPage() {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data: allIssues = [], isLoading: loading } = useQuery(issueListOptions(wsId));

  const workspace = useCurrentWorkspace();
  const scope = useIssuesScopeStore((s) => s.scope);
  const viewMode = useIssueViewStore((s) => s.viewMode);
  const statusFilters = useIssueViewStore((s) => s.statusFilters);
  const priorityFilters = useIssueViewStore((s) => s.priorityFilters);
  const assigneeFilters = useIssueViewStore((s) => s.assigneeFilters);
  const includeNoAssignee = useIssueViewStore((s) => s.includeNoAssignee);
  const creatorFilters = useIssueViewStore((s) => s.creatorFilters);
  const projectFilters = useIssueViewStore((s) => s.projectFilters);
  const includeNoProject = useIssueViewStore((s) => s.includeNoProject);
  const labelFilters = useIssueViewStore((s) => s.labelFilters);

  // Clear filter state when switching between workspaces (URL-driven).
  useClearFiltersOnWorkspaceChange(useIssueViewStore, wsId);

  useEffect(() => {
    useIssueSelectionStore.getState().clear();
  }, [viewMode, scope]);

  // Scope pre-filter: narrow by assignee type
  const scopedIssues = useMemo(() => {
    if (scope === "members")
      return allIssues.filter((i) => i.assignee_type === "member");
    if (scope === "agents")
      return allIssues.filter((i) => i.assignee_type === "agent");
    return allIssues;
  }, [allIssues, scope]);

  const issues = useMemo(
    () => filterIssues(scopedIssues, { statusFilters, priorityFilters, assigneeFilters, includeNoAssignee, creatorFilters, projectFilters, includeNoProject, labelFilters }),
    [scopedIssues, statusFilters, priorityFilters, assigneeFilters, includeNoAssignee, creatorFilters, projectFilters, includeNoProject, labelFilters],
  );

  // Fetch sub-issue progress from the backend so counts are accurate
  // regardless of client-side pagination or filtering of done issues.
  const { data: childProgressMap = new Map() } = useQuery(childIssueProgressOptions(wsId));

  const visibleStatuses = useMemo(() => {
    if (statusFilters.length > 0)
      return BOARD_STATUSES.filter((s) => statusFilters.includes(s));
    return BOARD_STATUSES;
  }, [statusFilters]);

  const hiddenStatuses = useMemo(() => {
    return BOARD_STATUSES.filter((s) => !visibleStatuses.includes(s));
  }, [visibleStatuses]);

  const updateIssueMutation = useUpdateIssue();
  const handleMoveIssue = useCallback(
    (issueId: string, newStatus: IssueStatus, newPosition?: number) => {
      const updates: Partial<{ status: IssueStatus; position: number }> = {
        status: newStatus,
      };
      if (newPosition !== undefined) updates.position = newPosition;

      updateIssueMutation.mutate(
        { id: issueId, ...updates },
        { onError: () => toast.error(t(($) => $.page.move_failed)) },
      );
    },
    [updateIssueMutation, t],
  );

  if (loading) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex h-12 shrink-0 items-center justify-between px-4">
          <div className="flex items-center gap-1">
            <Skeleton className="h-8 w-14 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
          <div className="flex items-center gap-1">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
        {viewMode === "list" ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex min-w-52 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-24 w-full rounded-lg" />
                <Skeleton className="h-24 w-full rounded-lg" />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Editorial issued-style date kicker — "FRI · MAY 8 · 2026" — surfaces the
  // current day so the page reads as "today's spread of work" the way the
  // mockup's `.crumbs` line reads "FRI · MAY 8 · 2026 · Daily review".
  const dateKicker = new Date()
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase()
    .replace(/,/g, "")
    .split(" ")
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header 1: Workspace breadcrumb (kept for nav context, quieted) */}
      <PageHeader className="gap-1.5">
        <WorkspaceAvatar name={workspace?.name ?? "W"} size="sm" />
        <span className="text-sm text-muted-foreground">
          {workspace?.name ?? t(($) => $.page.breadcrumb_workspace_fallback)}
        </span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm font-medium">{t(($) => $.page.breadcrumb_title)}</span>
      </PageHeader>

      {/* Editorial hero — kicker + serif h1 + italic lede.
       *  Mirrors the mockup's `.hero` block: a date-anchored small-caps
       *  kicker with a ✻ glyph, a 36-48px Source Serif 4 title with an
       *  italic caramel emphasis, and a serif italic lede summarising
       *  the volume of work waiting. Renders unconditionally so every
       *  visit to the issues page opens with the same "we're reading
       *  today's volume" beat — even when the list is empty. */}
      <header className="shrink-0 border-b px-8 pt-9 pb-7">
        <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <span aria-hidden className="text-base leading-none text-brand">✻</span>
          <span className="font-medium">{dateKicker} · {t(($) => $.page.breadcrumb_title)}</span>
        </div>
        <h1 className="text-balance font-serif text-[44px] font-medium leading-[1.05] tracking-tight text-foreground">
          {t(($) => $.page.breadcrumb_title)}
          {scopedIssues.length > 0 && (
            <em className="font-serif italic font-normal text-brand"> · {scopedIssues.length}</em>
          )}
        </h1>
        {scopedIssues.length > 0 && (
          <p className="mt-3 max-w-xl font-serif text-base italic leading-relaxed text-muted-foreground">
            {t(($) => $.page.empty_hint)}
          </p>
        )}
      </header>

      <ViewStoreProvider store={useIssueViewStore}>
        {/* Header 2: Scope tabs + filters */}
        <IssuesHeader scopedIssues={scopedIssues} />

        {/* Content: scrollable */}
        {scopedIssues.length === 0 ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-5 px-4 text-center">
            <span aria-hidden className="font-serif text-5xl leading-none text-brand">✻</span>
            <p className="max-w-sm font-serif text-lg italic leading-relaxed text-muted-foreground">
              {t(($) => $.page.empty_hint)}
            </p>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {viewMode === "board" ? (
              <BoardView
                issues={issues}
                visibleStatuses={visibleStatuses}
                hiddenStatuses={hiddenStatuses}
                onMoveIssue={handleMoveIssue}
                childProgressMap={childProgressMap}
              />
            ) : (
              <ListView issues={issues} visibleStatuses={visibleStatuses} childProgressMap={childProgressMap} />
            )}
          </div>
        )}
        {viewMode === "list" && <BatchActionToolbar />}
      </ViewStoreProvider>
    </div>
  );
}
