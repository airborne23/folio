"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@folio/core/auth";
import { workspaceKeys } from "@folio/core/workspace/queries";
import {
  paths,
  resolvePostAuthDestination,
  useHasOnboarded,
} from "@folio/core/paths";
import { api } from "@folio/core/api";
import type { Workspace } from "@folio/core/types";
import { setLoggedInCookie } from "@/features/auth/auth-cookie";
import { LoginPage, validateCliCallback } from "@folio/views/auth";

/**
 * Pick where a logged-in user with no explicit `?next=` should land.
 * Un-onboarded users with pending invitations on their email get routed to
 * the batch /invitations page; everyone else falls through to the standard
 * resolver. A network blip on listMyInvitations is non-fatal — we fall
 * through rather than trap the user on an error screen.
 */
async function resolveLoggedInDestination(
  qc: QueryClient,
  hasOnboarded: boolean,
  workspaces: Workspace[],
): Promise<string> {
  if (!hasOnboarded) {
    try {
      const invites = await api.listMyInvitations();
      if (invites.length > 0) {
        qc.setQueryData(workspaceKeys.myInvitations(), invites);
        return paths.invitations();
      }
    } catch {
      // fall through
    }
  }
  return resolvePostAuthDestination(workspaces, hasOnboarded);
}

function LoginPageContent() {
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const searchParams = useSearchParams();
  const cliCallbackRaw = searchParams.get("cli_callback");
  const cliState = searchParams.get("cli_state") || "";
  // Sanitise `?next=` first so a crafted off-origin URL can't bounce the
  // user away after a successful login.
  const nextUrl = sanitizeNextUrl(searchParams.get("next"));
  const hasOnboarded = useHasOnboarded();

  // Already authenticated? Honour `?next=` or pick a workspace landing.
  // CLI callback flow stays on this page so the LoginPage can show its
  // confirm step.
  useEffect(() => {
    if (isLoading || !user || cliCallbackRaw) return;
    if (nextUrl) {
      router.replace(nextUrl);
      return;
    }
    const list = qc.getQueryData<Workspace[]>(workspaceKeys.list()) ?? [];
    void resolveLoggedInDestination(qc, hasOnboarded, list).then((dest) =>
      router.replace(dest),
    );
  }, [isLoading, user, router, nextUrl, cliCallbackRaw, hasOnboarded, qc]);

  const handleSuccess = async () => {
    const currentUser = useAuthStore.getState().user;
    const onboarded = currentUser?.onboarded_at != null;
    if (nextUrl) {
      router.push(nextUrl);
      return;
    }
    const list = qc.getQueryData<Workspace[]>(workspaceKeys.list()) ?? [];
    const dest = await resolveLoggedInDestination(qc, onboarded, list);
    router.push(dest);
  };

  return (
    <LoginPage
      onSuccess={handleSuccess}
      cliCallback={
        cliCallbackRaw && validateCliCallback(cliCallbackRaw)
          ? { url: cliCallbackRaw, state: cliState }
          : undefined
      }
      onTokenObtained={setLoggedInCookie}
    />
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
