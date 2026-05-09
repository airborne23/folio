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

/**
 * The mode tabs and the submit button reuse the same i18n strings ("Sign
 * in", "Create account"), so a bare role query matches both. This helper
 * picks just the form-submit one — the click target most assertions
 * actually want.
 */
function getSubmitButton(name: RegExp) {
  return screen
    .getAllByRole("button", { name })
    .find((b) => b.getAttribute("type") === "submit");
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockStoreLogin = vi.hoisted(() => vi.fn());
const mockStoreSignup = vi.hoisted(() => vi.fn());
const mockApiLogin = vi.hoisted(() => vi.fn());
const mockApiSignup = vi.hoisted(() => vi.fn());
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
    (selector?: (s: unknown) => unknown) => {
      const state = { login: mockStoreLogin, signup: mockStoreSignup };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        login: mockStoreLogin,
        signup: mockStoreSignup,
      }),
    },
  ),
}));

// Real ApiError class so the page's instanceof check fires; api methods
// are mocked individually.
vi.mock("@folio/core/api", async () => {
  const actual = await vi.importActual<typeof import("@folio/core/api")>(
    "@folio/core/api",
  );
  return {
    ...actual,
    api: {
      listWorkspaces: mockApiListWorkspaces,
      login: mockApiLogin,
      signup: mockApiSignup,
      setToken: mockApiSetToken,
      getMe: mockApiGetMe,
      issueCliToken: mockApiIssueCliToken,
    },
  };
});

vi.mock("@folio/core/workspace/queries", () => ({
  workspaceKeys: { list: () => ["workspaces", "list"] },
}));

vi.mock("@folio/core/types", () => ({}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { LoginPage, validateCliCallback } from "./login-page";
import { ApiError } from "@folio/core/api";

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
  // Default render — Sign in mode
  // -------------------------------------------------------------------------

  it("renders Sign in mode by default with the email-only form", () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);
    expect(screen.getByText(/welcome to folio/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    // Name field is signup-only.
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    expect(getSubmitButton(/^sign in$/i)).toBeDefined();
  });

  it("Sign in button is disabled until email has a value", async () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);
    const button = getSubmitButton(/^sign in$/i)!;
    expect(button).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "a");
    expect(button).not.toBeDisabled();
    await user.clear(screen.getByLabelText(/email/i));
    expect(button).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Sign in flow (existing user)
  // -------------------------------------------------------------------------

  it("calls store.login, seeds workspace list, then onSuccess", async () => {
    mockStoreLogin.mockResolvedValueOnce({ id: "u-1" });
    mockApiListWorkspaces.mockResolvedValueOnce([{ id: "ws-1" }]);
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(getSubmitButton(/^sign in$/i)!);

    await waitFor(() => {
      expect(mockStoreLogin).toHaveBeenCalledWith("test@example.com");
      expect(mockApiListWorkspaces).toHaveBeenCalled();
      expect(mockSetQueryData).toHaveBeenCalledWith(
        ["workspaces", "list"],
        [{ id: "ws-1" }],
      );
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows the cross-link nudge when login returns 404", async () => {
    mockStoreLogin.mockRejectedValueOnce(new ApiError("not found", 404, ""));
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "ghost@example.com");
    await user.click(getSubmitButton(/^sign in$/i)!);

    await waitFor(() => {
      // Translated copy: "No account for this email — create one to get started."
      expect(screen.getByText(/no account for this email/i)).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("shows the loading label while login is in flight", async () => {
    mockStoreLogin.mockReturnValueOnce(new Promise(() => {}));
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(getSubmitButton(/^sign in$/i)!);

    expect(screen.getByText(/signing in/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Mode toggle and Create account flow
  // -------------------------------------------------------------------------

  it("switching to Create account reveals the name field", async () => {
    renderWithI18n(<LoginPage onSuccess={onSuccess} />);

    const user = userEvent.setup();
    // The mode tab uses tab_signup string → "Create account"
    await user.click(screen.getByRole("button", { name: /^create account$/i, pressed: false }));

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    // The submit button now reads "Create account" — same string but a
    // different element (the form submit, not the tab). It's disabled
    // until both fields are filled.
    const submitButtons = screen.getAllByRole("button", { name: /^create account$/i });
    const submit = submitButtons.find((b) => b.getAttribute("type") === "submit");
    expect(submit).toBeDefined();
  });

  it("calls store.signup with email and name on Create account submit", async () => {
    mockStoreSignup.mockResolvedValueOnce({ id: "u-1" });
    mockApiListWorkspaces.mockResolvedValueOnce([{ id: "ws-1" }]);
    renderWithI18n(<LoginPage onSuccess={onSuccess} initialMode="signup" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/name/i), "Test");
    const submit = screen
      .getAllByRole("button", { name: /^create account$/i })
      .find((b) => b.getAttribute("type") === "submit")!;
    await user.click(submit);

    await waitFor(() => {
      expect(mockStoreSignup).toHaveBeenCalledWith("test@example.com", "Test");
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows the cross-link nudge when signup returns 409", async () => {
    mockStoreSignup.mockRejectedValueOnce(new ApiError("conflict", 409, ""));
    renderWithI18n(<LoginPage onSuccess={onSuccess} initialMode="signup" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/name/i), "Test");
    const submit = screen
      .getAllByRole("button", { name: /^create account$/i })
      .find((b) => b.getAttribute("type") === "submit")!;
    await user.click(submit);

    await waitFor(() => {
      expect(
        screen.getByText(/already exists.*sign in instead/i),
      ).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // CLI callback — existing session
  // -------------------------------------------------------------------------

  it("shows cli_confirm step when existing session + cliCallback", async () => {
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

  it("detects cookie-based session and shows cli_confirm when no localStorage token", async () => {
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
  // CLI callback — fresh login + signup paths (no existing session)
  // -------------------------------------------------------------------------

  it("CLI sign-in mints a token and redirects to the callback URL", async () => {
    mockApiLogin.mockResolvedValueOnce({
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
    await user.click(getSubmitButton(/^sign in$/i)!);

    await waitFor(() => {
      expect(mockApiLogin).toHaveBeenCalledWith("cli@example.com");
      expect(onTokenObtained).toHaveBeenCalled();
      expect(window.location.href).toContain(
        "http://localhost:9876/callback?token=new-jwt-token&state=xyz",
      );
    });

    expect(mockStoreLogin).not.toHaveBeenCalled();
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

  it("calls onTokenObtained after a successful non-CLI login", async () => {
    mockStoreLogin.mockResolvedValueOnce({ id: "u-1" });
    mockApiListWorkspaces.mockResolvedValueOnce([{ id: "ws-1" }]);
    const onTokenObtained = vi.fn();

    renderWithI18n(
      <LoginPage onSuccess={onSuccess} onTokenObtained={onTokenObtained} />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.click(getSubmitButton(/^sign in$/i)!);

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
