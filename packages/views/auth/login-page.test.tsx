import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@folio/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enAuth from "../locales/en/auth.json";
import enSettings from "../locales/en/settings.json";

const TEST_RESOURCES = {
  en: { common: enCommon, auth: enAuth, settings: enSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function renderWithI18n(ui: ReactElement) {
  return render(ui, { wrapper: I18nWrapper });
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockStoreQuickSignup = vi.hoisted(() => vi.fn());
const mockApiQuickSignup = vi.hoisted(() => vi.fn());
const mockApiListWorkspaces = vi.hoisted(() => vi.fn());
const mockApiSetToken = vi.hoisted(() => vi.fn());
const mockApiGetMe = vi.hoisted(() => vi.fn());
const mockApiIssueCliToken = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQueryClient: () => ({ setQueryData: mockSetQueryData }) };
});

vi.mock("@folio/core/auth", () => ({
  useAuthStore: Object.assign(
    // Zustand hook form — component may call useAuthStore(selector)
    (selector?: (s: unknown) => unknown) => {
      const state = { quickSignup: mockStoreQuickSignup };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        quickSignup: mockStoreQuickSignup,
      }),
    },
  ),
}));

vi.mock("@folio/core/api", () => ({
  api: {
    listWorkspaces: mockApiListWorkspaces,
    quickSignup: mockApiQuickSignup,
    setToken: mockApiSetToken,
    getMe: mockApiGetMe,
    issueCliToken: mockApiIssueCliToken,
  },
}));

vi.mock("@folio/core/workspace/queries", () => ({
  workspaceKeys: { list: () => ["workspaces", "list"] },
}));

vi.mock("@folio/core/types", () => ({}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { LoginPage, validateCliCallback } from "./login-page";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoginPage", () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing session (getMe rejects when no auth)
    mockApiGetMe.mockRejectedValue(new Error("unauthorized"));
    localStorage.clear();
    // Reset window.location for tests that change it
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "http://localhost:3000" },
    });
  });

  // -------------------------------------------------------------------------
  // Email + name form rendering
  // -------------------------------------------------------------------------

  it("renders the welcome form with email + name fields and the Begin button", () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);
    expect(screen.getByText(/welcome to folio/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^begin$/i }),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Email enables / disables the Begin button
  // -------------------------------------------------------------------------

  it("Begin button toggles enabled state with the email field", async () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);
    const button = screen.getByRole("button", { name: /^begin$/i });
    expect(button).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "a");
    expect(button).not.toBeDisabled();
    await user.clear(screen.getByLabelText(/email/i));
    expect(button).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // quickSignup — non-CLI path
  // -------------------------------------------------------------------------

  it("calls store.quickSignup, seeds workspace list, then onSuccess", async () => {
    mockStoreQuickSignup.mockResolvedValueOnce({ id: "u-1" });
    mockApiListWorkspaces.mockResolvedValueOnce([{ id: "ws-1" }]);
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/name/i), "Test");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    await waitFor(() => {
      expect(mockStoreQuickSignup).toHaveBeenCalledWith(
        "test@example.com",
        "Test",
      );
      expect(mockApiListWorkspaces).toHaveBeenCalled();
      // The workspace list is seeded into React Query so onSuccess can read
      // it synchronously to compute a destination URL.
      expect(mockSetQueryData).toHaveBeenCalledWith(
        ["workspaces", "list"],
        [{ id: "ws-1" }],
      );
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows the error message when quickSignup rejects with an Error", async () => {
    mockStoreQuickSignup.mockRejectedValueOnce(new Error("Rate limited"));
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    await waitFor(() => {
      expect(screen.getByText("Rate limited")).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("shows a generic error when quickSignup throws a non-Error value", async () => {
    mockStoreQuickSignup.mockRejectedValueOnce("boom");
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    await waitFor(() => {
      // auth.json $.errors.send_failed → "Failed to send code." is the
      // current generic-error fallback string.
      expect(screen.getByText(/failed to send code/i)).toBeInTheDocument();
    });
  });

  it("shows the loading label while quickSignup is in flight", async () => {
    // Never resolve so loading stays true
    mockStoreQuickSignup.mockReturnValueOnce(new Promise(() => {}));
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    // auth.json $.signin.sending → "Signing you in…"
    expect(screen.getByText(/signing you in/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // CLI callback — existing session
  // -------------------------------------------------------------------------

  it("shows cli_confirm step when existing session + cliCallback", async () => {
    localStorage.setItem("folio_token", "existing-jwt");
    // Cookie attempt fails first, then localStorage fallback succeeds
    mockApiGetMe
      .mockRejectedValueOnce(new Error("no cookie"))
      .mockResolvedValueOnce({
        id: "u-1",
        email: "user@example.com",
        name: "Test User",
      });

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/authorize cli/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/user@example.com/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^authorize$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use a different account/i }),
    ).toBeInTheDocument();
  });

  it("CLI authorize button (localStorage token) redirects to callback URL", async () => {
    localStorage.setItem("folio_token", "existing-jwt");
    mockApiGetMe
      .mockRejectedValueOnce(new Error("no cookie"))
      .mockResolvedValueOnce({
        id: "u-1",
        email: "user@example.com",
        name: "Test User",
      });
    const onTokenObtained = vi.fn();

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        onTokenObtained={onTokenObtained}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/authorize cli/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^authorize$/i }));

    expect(onTokenObtained).toHaveBeenCalled();
    expect(window.location.href).toContain(
      "http://localhost:9876/callback?token=existing-jwt&state=abc",
    );
  });

  it("'Use a different account' returns to the welcome form", async () => {
    localStorage.setItem("folio_token", "existing-jwt");
    mockApiGetMe
      .mockRejectedValueOnce(new Error("no cookie"))
      .mockResolvedValueOnce({
        id: "u-1",
        email: "user@example.com",
        name: "Test User",
      });

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/authorize cli/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /use a different account/i }),
    );

    expect(screen.getByText(/welcome to folio/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // CLI callback — cookie-based session (no localStorage token)
  // -------------------------------------------------------------------------

  it("detects cookie-based session and shows cli_confirm when no localStorage token", async () => {
    // No localStorage token — getMe succeeds via HttpOnly cookie
    mockApiGetMe.mockResolvedValueOnce({
      id: "u-1",
      email: "cookie@example.com",
      name: "Cookie User",
    });

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/authorize cli/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/cookie@example.com/)).toBeInTheDocument();
  });

  it("CLI authorize with cookie session calls issueCliToken and redirects", async () => {
    mockApiGetMe.mockResolvedValueOnce({
      id: "u-1",
      email: "cookie@example.com",
      name: "Cookie User",
    });
    mockApiIssueCliToken.mockResolvedValueOnce({ token: "fresh-jwt" });
    const onTokenObtained = vi.fn();

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        onTokenObtained={onTokenObtained}
        cliCallback={{ url: "http://localhost:9876/callback", state: "abc" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/authorize cli/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^authorize$/i }));

    await waitFor(() => {
      expect(mockApiIssueCliToken).toHaveBeenCalled();
      expect(onTokenObtained).toHaveBeenCalled();
      expect(window.location.href).toContain(
        "http://localhost:9876/callback?token=fresh-jwt&state=abc",
      );
    });
  });

  // -------------------------------------------------------------------------
  // CLI callback — quickSignup redirect (no existing session)
  // -------------------------------------------------------------------------

  it("CLI quickSignup mints a token and redirects to the callback URL", async () => {
    mockApiQuickSignup.mockResolvedValueOnce({
      token: "new-jwt-token",
      user: { id: "u-1", email: "cli@example.com", name: "CLI User" },
    });
    const onTokenObtained = vi.fn();

    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        onTokenObtained={onTokenObtained}
        cliCallback={{ url: "http://localhost:9876/callback", state: "xyz" }}
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "cli@example.com");
    await user.type(screen.getByLabelText(/name/i), "CLI User");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    await waitFor(() => {
      expect(mockApiQuickSignup).toHaveBeenCalledWith(
        "cli@example.com",
        "CLI User",
      );
      expect(onTokenObtained).toHaveBeenCalled();
      expect(window.location.href).toContain(
        "http://localhost:9876/callback?token=new-jwt-token&state=xyz",
      );
    });

    // Store-level quickSignup is bypassed on the CLI path.
    expect(mockStoreQuickSignup).not.toHaveBeenCalled();
    // onSuccess should NOT fire on the CLI path — the redirect handles it.
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Logo prop
  // -------------------------------------------------------------------------

  it("renders logo when provided", () => {
    renderWithI18n(
      <LoginPage
        onSuccess={onSuccess}
        logo={<div data-testid="custom-logo">Logo</div>}
      />,
    );
    expect(screen.getByTestId("custom-logo")).toBeInTheDocument();
  });

  it("does not render logo placeholder when omitted", () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);
    expect(screen.queryByTestId("custom-logo")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // onTokenObtained callback (non-CLI path)
  // -------------------------------------------------------------------------

  it("calls onTokenObtained after a successful non-CLI quickSignup", async () => {
    mockStoreQuickSignup.mockResolvedValueOnce({ id: "u-1" });
    mockApiListWorkspaces.mockResolvedValueOnce([{ id: "ws-1" }]);
    const onTokenObtained = vi.fn();

    renderWithI18n(
      <LoginPage onSuccess={onSuccess} onTokenObtained={onTokenObtained} />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(screen.getByRole("button", { name: /^begin$/i }));

    await waitFor(() => {
      expect(onTokenObtained).toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// validateCliCallback (exported helper)
// ---------------------------------------------------------------------------

describe("validateCliCallback", () => {
  it("accepts http://localhost", () => {
    expect(validateCliCallback("http://localhost:9876/callback")).toBe(true);
  });

  it("accepts http://127.0.0.1", () => {
    expect(validateCliCallback("http://127.0.0.1:8080/cb")).toBe(true);
  });

  it("accepts 10.x.x.x private IPs", () => {
    expect(validateCliCallback("http://10.0.0.5:9876/callback")).toBe(true);
    expect(validateCliCallback("http://10.255.255.255:1234/cb")).toBe(true);
  });

  it("accepts 172.16-31.x.x private IPs", () => {
    expect(validateCliCallback("http://172.16.0.1:9876/callback")).toBe(true);
    expect(validateCliCallback("http://172.31.255.255:1234/cb")).toBe(true);
  });

  it("rejects 172.x outside 16-31 range", () => {
    expect(validateCliCallback("http://172.15.0.1:9876/callback")).toBe(false);
    expect(validateCliCallback("http://172.32.0.1:9876/callback")).toBe(false);
  });

  it("accepts 192.168.x.x private IPs", () => {
    expect(validateCliCallback("http://192.168.1.131:41117/callback")).toBe(true);
    expect(validateCliCallback("http://192.168.0.1:8080/cb")).toBe(true);
  });

  it("rejects https:// URLs", () => {
    expect(validateCliCallback("https://localhost:9876/callback")).toBe(false);
  });

  it("rejects public IPs and domains", () => {
    expect(validateCliCallback("http://evil.com:9876/callback")).toBe(false);
    expect(validateCliCallback("http://8.8.8.8:9876/callback")).toBe(false);
    expect(validateCliCallback("http://192.169.1.1:9876/callback")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(validateCliCallback("not-a-url")).toBe(false);
  });
});
