"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { setCurrentWorkspace } from "@folio/core/platform";
import { useAuthStore } from "@folio/core/auth";
import { completeOnboarding, type OnboardingStep } from "@folio/core/onboarding";
import { workspaceListOptions } from "@folio/core/workspace/queries";
import type { Workspace } from "@folio/core/types";
import { StepWorkspace } from "./steps/step-workspace";
import { useT } from "../i18n";

/**
 * Simplified onboarding shell — single step, "name your workspace."
 *
 * The legacy six-step flow (welcome / questionnaire / workspace / runtime
 * / agent / first_issue) was collapsed to a single StepWorkspace per the
 * "登录后只填工作区名" product call. Returning users with at least one
 * workspace bypass onboarding entirely (the page-level guard catches
 * them); first-time users land here, type a name, and ship.
 *
 * `completeOnboarding("runtime_skipped")` flags the user as onboarded
 * without claiming any later step ran. We pick `runtime_skipped` over a
 * new "simplified" path to stay backward-compatible with the analytics
 * funnel — adding a new path requires a paired backend constant. The
 * label is slightly inaccurate ("we never ran the runtime step") but the
 * funnel only cares about completion, not provenance.
 */
export function OnboardingFlow({
  onComplete,
}: {
  onComplete: (workspace?: Workspace) => void;
}) {
  const { t } = useT("onboarding");
  const user = useAuthStore((s) => s.user);
  if (!user) {
    throw new Error("OnboardingFlow requires an authenticated user");
  }

  // Use existing workspace as the resume option when present (rare —
  // most onboarding visitors have zero workspaces — but covers the
  // "I created one then bailed mid-flow" path).
  const { data: workspaces = [] } = useQuery(workspaceListOptions());
  const existing = workspaces[0] ?? null;

  const handleCreated = useCallback(
    async (ws: Workspace) => {
      setCurrentWorkspace(ws.slug, ws.id);
      try {
        await completeOnboarding("runtime_skipped");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t(($) => $.errors.skip_failed),
        );
      }
      onComplete(ws);
    },
    [onComplete, t],
  );

  return <StepWorkspace existing={existing} onCreated={handleCreated} />;
}

export type { OnboardingStep };
