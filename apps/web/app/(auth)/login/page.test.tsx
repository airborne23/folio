import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@folio/core/i18n/react";
import enCommon from "@folio/views/locales/en/common.json";
import enAuth from "@folio/views/locales/en/auth.json";
import enSettings from "@folio/views/locales/en/settings.json";
import type { ReactNode } from "react";

const TEST_RESOURCES = {
  en: { common: enCommon, auth: enAuth, settings: enSettings },
};

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

/** The mode tabs and the form-submit button reuse the same i18n strings,
 *  so a bare `getByRole` matches both. Pick just the submit. */
function getSubmitButton(name: RegExp) {
  return screen
    .getAllByRole("button", { name })
    .find((b) => b.getAttribute("type") === "submit");
}

const {
  mockLogin,
  mockSignup,
  mockListWorkspaces,
  searchParamsState,
  authStateRef,
  mockRouterPush,
  mockRouterReplace,
} = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockSignup: vi.fn(),
  mockListWorkspaces: vi.fn(),
  searchParamsState: { params: new URLSearchParams() },
  authStateRef: {
    state: {
      login: vi.fn(),
      signup: vi.fn(),
      user: null as null | { id: string; email: string; onboarded_at: string | null },
      isLoading: false,
    },
  },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
  usePathname: () => "/login",
  useSearchParams: () => searchParamsState.params,
}));

// Shared LoginPage uses getState().login/signup; web wrapper uses
// useAuthStore((s) => s.user/isLoading). Keep the real sanitizeNextUrl so
// the redirect-sanitization rules are exercised rather than silently
// drifting behind a mock reimplementation.
vi.mock("@folio/core/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@folio/core/auth")>(
      "@folio/core/auth",
    );
  authStateRef.state.login = mockLogin;
  authStateRef.state.signup = mockSignup;
  const useAuthStore = Object.assign(
    (selector: (s: typeof authStateRef.state) => unknown) =>
      selector(authStateRef.state),
    { getState: () => authStateRef.state },
  );
  return { ...actual, useAuthStore };
});

vi.mock("@/features/auth/auth-cookie", () => ({
  setLoggedInCookie: vi.fn(),
}));

vi.mock("@folio/core/api", async () => {
  const actual = await vi.importActual<typeof import("@folio/core/api")>(
    "@folio/core/api",
  );
  return {
    ...actual,
    api: {
      listWorkspaces: mockListWorkspaces,
      listMyInvitations: vi.fn().mockResolvedValue([]),
      login: vi.fn(),
      signup: vi.fn(),
      setToken: vi.fn(),
      getMe: vi.fn(),
      issueCliToken: vi.fn(),
    },
  };
});

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsState.params = new URLSearchParams();
    authStateRef.state.user = null;
    authStateRef.state.isLoading = false;
    mockListWorkspaces.mockResolvedValue([]);
  });

  it("renders Sign in mode by default with the email-only form", () => {
    render(<LoginPage />, { wrapper: createWrapper() });

    expect(screen.getByText(/welcome to folio/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    expect(getSubmitButton(/^sign in$/i)).toBeDefined();
  });

  it("does not call login when email is empty (button stays disabled)", async () => {
    const user = userEvent.setup();
    render(<LoginPage />, { wrapper: createWrapper() });

    const button = getSubmitButton(/^sign in$/i)!;
    expect(button).toBeDisabled();
    await user.click(button);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("calls login with email on Sign in submit", async () => {
    mockLogin.mockResolvedValueOnce({ id: "u-1" });
    const user = userEvent.setup();
    render(<LoginPage />, { wrapper: createWrapper() });

    await user.type(screen.getByLabelText(/email/i), "test@folio.ai");
    await user.click(getSubmitButton(/^sign in$/i)!);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("test@folio.ai");
    });
  });

  it("calls signup with email + name on Create account submit", async () => {
    mockSignup.mockResolvedValueOnce({ id: "u-1" });
    const user = userEvent.setup();
    render(<LoginPage />, { wrapper: createWrapper() });

    // Switch to Create account tab.
    await user.click(
      screen.getByRole("button", { name: /^create account$/i, pressed: false }),
    );

    await user.type(screen.getByLabelText(/email/i), "test@folio.ai");
    await user.type(screen.getByLabelText(/name/i), "Test");

    const submit = screen
      .getAllByRole("button", { name: /^create account$/i })
      .find((b) => b.getAttribute("type") === "submit")!;
    await user.click(submit);

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith("test@folio.ai", "Test");
    });
  });

  // Regression: an already-authenticated user landing on /login should be
  // bounced to their post-auth destination immediately, rather than seeing
  // the welcome form. The CLI callback flow is the single exception (handled
  // by the shared LoginPage's confirm step).
  it("redirects already-logged-in users away from /login", async () => {
    authStateRef.state.user = {
      id: "u-1",
      email: "test@folio.ai",
      onboarded_at: "2026-05-01T00:00:00Z",
    };
    render(<LoginPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalled();
    });
  });
});
