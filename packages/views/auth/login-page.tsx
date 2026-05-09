"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@folio/ui/components/ui/input";
import { Button } from "@folio/ui/components/ui/button";
import { Label } from "@folio/ui/components/ui/label";
import { useAuthStore } from "@folio/core/auth";
import { workspaceKeys } from "@folio/core/workspace/queries";
import { api } from "@folio/core/api";
import type { User } from "@folio/core/types";
import { FolioIcon } from "@folio/ui/components/common/folio-icon";
import { useT } from "../i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CliCallbackConfig {
  /** Validated localhost callback URL */
  url: string;
  /** Opaque state to pass back to CLI */
  state: string;
}

interface LoginPageProps {
  /** Logo element rendered above the title (web shells override; desktop omits). */
  logo?: ReactNode;
  /** Called after successful login. The workspace list is seeded into React
   *  Query before this fires, so the caller can compute a destination URL. */
  onSuccess: () => void;
  /** CLI callback config for authorizing CLI tools. */
  cliCallback?: CliCallbackConfig;
  /** Called after a token is obtained (e.g. to set cookies). */
  onTokenObtained?: () => void;
  /** Slot rendered at the bottom of the form. */
  extra?: ReactNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redirectToCliCallback(url: string, token: string, state: string) {
  const separator = url.includes("?") ? "&" : "?";
  window.location.href = `${url}${separator}token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
}

/**
 * Validate that a CLI callback URL points to a safe host over HTTP.
 * Allows localhost and private/LAN IPs (RFC 1918) to support self-hosted setups
 * on local VMs while blocking arbitrary public hosts.
 */
export function validateCliCallback(cliCallback: string): boolean {
  try {
    const cbUrl = new URL(cliCallback);
    if (cbUrl.protocol !== "http:") return false;
    const h = cbUrl.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (/^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Editorial LoginPage
// ---------------------------------------------------------------------------

/**
 * Simplified, no-verification entry surface. Two fields (email + name), one
 * button. On submit the backend's QuickSignup either creates the user or
 * logs an existing one in, and we land in the workspace.
 *
 * Visual contract follows the Anthropic-cream chrome used elsewhere: ✻
 * caramel star, Source Serif 4 hero, italic serif lede, paper canvas (no
 * card chrome). The form fields sit unframed below the lede so the page
 * reads as "fill in your name, begin," not "fill in this form to register
 * an account on Folio Inc., proceed to step 2 of 4, etc."
 */
export function LoginPage({
  logo,
  onSuccess,
  cliCallback,
  onTokenObtained,
  extra,
}: LoginPageProps) {
  const { t } = useT("auth");
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [existingUser, setExistingUser] = useState<User | null>(null);
  // Tracks how the existing session was detected so the CLI confirm path
  // uses the matching token source (cookie → issueCliToken, localStorage →
  // direct).
  const authSourceRef = useRef<"cookie" | "localStorage">("cookie");

  // Detect existing session for the CLI authorize flow. Cookie auth is
  // preferred (it's the current browser session); falls back to a stored
  // bearer token if cookie is absent or rejected.
  useEffect(() => {
    if (!cliCallback) return;
    api.setToken(null);
    api
      .getMe()
      .then((user) => {
        authSourceRef.current = "cookie";
        setExistingUser(user);
      })
      .catch(() => {
        const token = localStorage.getItem("folio_token");
        if (!token) return;
        api.setToken(token);
        api
          .getMe()
          .then((user) => {
            authSourceRef.current = "localStorage";
            setExistingUser(user);
          })
          .catch(() => {
            api.setToken(null);
            localStorage.removeItem("folio_token");
          });
      });
  }, [cliCallback]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmedEmail = email.trim();
      const trimmedName = name.trim();
      if (!trimmedEmail) {
        setError(t(($) => $.common.email_required));
        return;
      }
      setLoading(true);
      setError("");
      try {
        if (cliCallback) {
          // CLI path: get the token directly from QuickSignup so we can
          // hand it off to the CLI without requiring a separate cookie
          // issue step.
          const { token } = await api.quickSignup(trimmedEmail, trimmedName);
          localStorage.setItem("folio_token", token);
          api.setToken(token);
          onTokenObtained?.();
          redirectToCliCallback(cliCallback.url, token, cliCallback.state);
          return;
        }
        // Standard web/desktop path: store updates user, seed workspace
        // list into Query cache so the post-login destination resolver
        // can read it synchronously.
        await useAuthStore.getState().quickSignup(trimmedEmail, trimmedName);
        const wsList = await api.listWorkspaces();
        qc.setQueryData(workspaceKeys.list(), wsList);
        onTokenObtained?.();
        onSuccess();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t(($) => $.errors.send_failed),
        );
        setLoading(false);
      }
    },
    [email, name, cliCallback, onSuccess, onTokenObtained, qc, t],
  );

  const handleCliAuthorize = async () => {
    if (!cliCallback) return;
    setLoading(true);
    try {
      let token: string;
      if (authSourceRef.current === "localStorage") {
        const stored = localStorage.getItem("folio_token");
        if (!stored) throw new Error("token missing");
        token = stored;
      } else {
        const res = await api.issueCliToken();
        token = res.token;
      }
      onTokenObtained?.();
      redirectToCliCallback(cliCallback.url, token, cliCallback.state);
    } catch {
      setError(t(($) => $.errors.cli_auth_failed));
      setExistingUser(null);
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // CLI confirm — existing session, just authorise the CLI tool
  // -------------------------------------------------------------------------

  if (cliCallback && existingUser) {
    return (
      <Shell logo={logo}>
        <h1 className="text-balance text-center font-serif text-3xl font-medium leading-tight tracking-tight text-foreground">
          {t(($) => $.cli.title)}
        </h1>
        <p className="mt-3 max-w-md text-center font-serif text-base italic leading-relaxed text-muted-foreground">
          {t(($) => $.cli.description, { email: existingUser.email })}
        </p>
        <div className="mt-8 flex w-full max-w-xs flex-col gap-2.5">
          <Button
            onClick={handleCliAuthorize}
            disabled={loading}
            size="lg"
            className="w-full"
          >
            {loading ? t(($) => $.cli.authorizing) : t(($) => $.cli.authorize)}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => setExistingUser(null)}
          >
            {t(($) => $.cli.different_account)}
          </Button>
        </div>
      </Shell>
    );
  }

  // -------------------------------------------------------------------------
  // Default — email + name form
  // -------------------------------------------------------------------------

  return (
    <Shell logo={logo}>
      <h1 className="text-balance text-center font-serif text-[42px] font-medium leading-[1.05] tracking-tight text-foreground">
        {t(($) => $.signin.title)}
      </h1>
      <p className="mt-3 max-w-md text-center font-serif text-base italic leading-relaxed text-muted-foreground">
        {t(($) => $.signin.description)}
      </p>

      <form onSubmit={handleSubmit} className="mt-10 flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="login-email"
            className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
          >
            {t(($) => $.common.email)}
          </Label>
          <Input
            id="login-email"
            type="email"
            placeholder={t(($) => $.common.email_placeholder)}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="login-name"
            className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
          >
            {t(($) => $.common.name)}
          </Label>
          <Input
            id="login-name"
            type="text"
            placeholder={t(($) => $.common.name_placeholder)}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="submit"
          disabled={!email || loading}
          size="lg"
          className="mt-2 w-full"
        >
          {loading ? t(($) => $.signin.sending) : t(($) => $.signin.continue)}
        </Button>
      </form>

      {extra && <div className="mt-6 max-w-sm text-center text-xs text-muted-foreground">{extra}</div>}
    </Shell>
  );
}

/**
 * Editorial page chrome — Folio open-spread mark at top, then the
 * supplied logo (if any), then page content centered on the cream
 * paper. No card frame; the page is the surface.
 */
function Shell({ logo, children }: { logo?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-16">
      <FolioIcon className="text-6xl" />
      {logo && <div className="mt-4">{logo}</div>}
      <div className="mt-6 flex flex-col items-center">{children}</div>
      {/* eslint-disable-next-line i18next/no-literal-string -- brand tagline; not localized. */}
      <footer className="mt-16 font-serif text-xs italic text-muted-foreground">
        Folio · designed with patience
      </footer>
    </div>
  );
}
