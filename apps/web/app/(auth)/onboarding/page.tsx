"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@folio/core/auth";
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

  useEffect(() => {
    if (isLoading || !user) {
      if (!isLoading && !user) router.replace(paths.login());
      return;
    }
    if (!workspacesFetched) return;
    // Bounce out only when onboarding doesn't apply — the user is already
    // onboarded. With the simplified single-step flow, a user that has at
    // least one workspace is also considered "done" (the only step the
    // flow had was creating a workspace), so route them straight to it.
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
