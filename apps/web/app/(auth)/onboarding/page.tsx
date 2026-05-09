"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@folio/core/auth";
import { completeOnboarding } from "@folio/core/onboarding";
import {
  paths,
  resolvePostAuthDestination,
  useHasOnboarded,
} from "@folio/core/paths";
import { workspaceListOptions } from "@folio/core/workspace/queries";
import { OnboardingFlow } from "@folio/views/onboarding";

/**
 * Web shell for the onboarding flow. Route is the platform chrome on web
 * (mirrors `WindowOverlay` on desktop); content is the shared single-step
 * `<OnboardingFlow />` that just collects a workspace name.
 *
 * On complete: navigate into the freshly-created workspace's issues list;
 * fallback to root if the flow somehow ends without a workspace.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const hasOnboarded = useHasOnboarded();
  const { data: workspaces = [], isFetched: workspacesFetched } = useQuery({
    ...workspaceListOptions(),
    enabled: !!user,
  });
  // Single-shot guard: prevents the inconsistent-state recovery branch
  // below from firing repeatedly while completeOnboarding is in flight or
  // while the user/workspace queries are re-resolving on the next render.
  const recoveryFiredRef = useRef(false);

  useEffect(() => {
    if (isLoading || !user) {
      if (!isLoading && !user) router.replace(paths.login());
      return;
    }
    if (!workspacesFetched) return;
    // Recovery path for the "has-workspace, not-onboarded" inconsistency.
    // Backend invariant says it shouldn't happen, but it does in practice
    // (manual DB seeds, partial migrations, the imported-via-SQL case
    // we hit during deploy). Without this branch, resolvePostAuthDestination
    // routes back to /onboarding because !onboarded — but the page below
    // returns null because workspaces.length > 0, leaving a blank screen
    // and an infinite router.replace loop. Backfill onboarded_at so the
    // user's profile matches what the data already implies, then send
    // them into their workspace.
    const firstWorkspace = workspaces[0];
    if (!hasOnboarded && firstWorkspace) {
      if (recoveryFiredRef.current) return;
      recoveryFiredRef.current = true;
      void (async () => {
        try {
          await completeOnboarding("skip_existing");
        } catch (err) {
          // Best-effort. Log so a real backend failure surfaces in the
          // browser console without blocking the redirect — the user
          // would rather land in their workspace than be stuck here.
          console.warn(
            "onboarding: failed to backfill onboarded_at (continuing redirect)",
            err,
          );
        }
        router.replace(paths.workspace(firstWorkspace.slug).issues());
      })();
      return;
    }
    if (hasOnboarded || workspaces.length > 0) {
      router.replace(resolvePostAuthDestination(workspaces, hasOnboarded));
    }
  }, [isLoading, user, hasOnboarded, workspacesFetched, workspaces, router]);

  if (isLoading || !user || hasOnboarded || workspaces.length > 0) return null;

  // Layout: page owns its own scroll (root layout sets body { overflow:
  // hidden } for the app-shell convention). OnboardingFlow owns the
  // step's width constraint internally.
  return (
    <div className="h-full overflow-y-auto bg-background">
      <OnboardingFlow
        onComplete={(ws) => {
          if (ws) {
            router.push(paths.workspace(ws.slug).issues());
          } else {
            router.push(paths.root());
          }
        }}
      />
    </div>
  );
}
