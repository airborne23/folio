import { type Page } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";

const DEFAULT_E2E_NAME = "E2E User";
const DEFAULT_E2E_EMAIL = "e2e@folio.ai";
const DEFAULT_E2E_WORKSPACE = "e2e-workspace";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || "8080"}`;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://folio:folio@localhost:5432/folio?sslmode=disable";

/**
 * Log in as the default E2E user and ensure the workspace exists first.
 *
 * Auth strategy: use the Playwright browser request context to call
 * /auth/verify-code so the backend sets the HttpOnly `folio_auth` cookie
 * and the readable `folio_csrf` cookie directly on the browser's cookie jar.
 * This is necessary because the web app defaults to cookie-based auth (not
 * the legacy localStorage token path).
 *
 * Returns the E2E workspace slug so callers can build workspace-scoped URLs.
 */
export async function loginAsDefault(page: Page): Promise<string> {
  // Step 1: ensure a fresh verification code exists via server-side Node
  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  let code: string;
  try {
    await client.query("DELETE FROM verification_code WHERE email = $1", [
      DEFAULT_E2E_EMAIL,
    ]);
    const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEFAULT_E2E_EMAIL }),
    });
    if (!sendRes.ok) throw new Error(`send-code failed: ${sendRes.status}`);

    const result = await client.query(
      "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [DEFAULT_E2E_EMAIL],
    );
    if (result.rows.length === 0)
      throw new Error(`No verification code found for ${DEFAULT_E2E_EMAIL}`);
    code = result.rows[0].code as string;
  } finally {
    await client.end();
  }

  // Step 2: call verify-code via the Playwright browser context so the
  // backend's Set-Cookie response lands in the browser's cookie jar.
  const verifyRes = await page.request.post(`${API_BASE}/auth/verify-code`, {
    data: { email: DEFAULT_E2E_EMAIL, code },
    headers: { "Content-Type": "application/json" },
  });
  if (!verifyRes.ok()) {
    throw new Error(`verify-code failed: ${verifyRes.status()}`);
  }

  // Step 3: set the non-HttpOnly "logged in" indicator cookie that the
  // Next.js middleware and client-side code read.
  await page.context().addCookies([
    {
      name: "folio_logged_in",
      value: "1",
      domain: "localhost",
      path: "/",
      maxAge: 31536000,
      sameSite: "Lax",
    },
  ]);

  // Step 4: ensure the workspace exists using the Node-side client
  const api = new TestApiClient();
  await api.login(DEFAULT_E2E_EMAIL, DEFAULT_E2E_NAME);
  const workspace = await api.ensureWorkspace(
    "E2E Workspace",
    DEFAULT_E2E_WORKSPACE,
  );

  // Step 5: update user name if needed (best-effort)
  if (DEFAULT_E2E_NAME) {
    const token = api.getToken();
    if (token) {
      await fetch(`${API_BASE}/api/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: DEFAULT_E2E_NAME }),
      }).catch(() => {
        /* ignore */
      });
    }
  }

  // Step 6: navigate and wait for the workspace dashboard to load
  await page.goto(`/${workspace.slug}/issues`);
  await page.waitForURL("**/issues", { timeout: 15000 });
  return workspace.slug;
}

/**
 * Create a TestApiClient logged in as the default E2E user.
 * Call api.cleanup() in afterEach to remove test data created during the test.
 */
export async function createTestApi(): Promise<TestApiClient> {
  const api = new TestApiClient();
  await api.login(DEFAULT_E2E_EMAIL, DEFAULT_E2E_NAME);
  await api.ensureWorkspace("E2E Workspace", DEFAULT_E2E_WORKSPACE);
  return api;
}

export async function openWorkspaceMenu(page: Page) {
  // Click the workspace switcher button (has ChevronDown icon)
  await page.locator("aside button").first().click();
  // Wait for dropdown to appear
  await page.locator('[class*="popover"]').waitFor({ state: "visible" });
}
