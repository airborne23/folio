import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Channels realtime", () => {
  let api: TestApiClient;

  test.beforeEach(async () => {
    api = await createTestApi();
  });

  test.afterEach(async () => {
    if (api) await api.cleanup();
  });

  test("tab B sees tab A's new channel and new message without refresh", async ({ browser }) => {
    // Two independent browser contexts — each has its own cookies + WS connection.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    // Login sequentially — loginAsDefault deletes all verification codes for
    // the e2e email and inserts a fresh one each call; concurrent calls would
    // race on that DELETE/INSERT, so we serialize them.
    await loginAsDefault(a);
    await loginAsDefault(b);

    // Dismiss onboarding "Welcome — add starter tasks?" dialog if present on
    // each tab. Same pattern as channels-basic.spec.ts.
    for (const p of [a, b]) {
      try {
        const blank = p.getByRole("button", { name: /start blank workspace/i });
        await blank.waitFor({ state: "visible", timeout: 5000 });
        await blank.click();
        await p
          .locator('[data-slot="dialog-overlay"]')
          .waitFor({ state: "hidden", timeout: 5000 });
      } catch {
        // Dialog not present — continue
      }
    }

    // Both tabs navigate to the channels list.
    for (const p of [a, b]) {
      await p.getByRole("link", { name: "Channels" }).click();
      await p.waitForURL("**/channels");
    }

    // Tab A creates a unique-named public channel via the dialog.
    await a.getByRole("button", { name: /new channel/i }).click();
    const name = `e2e-rt-${Date.now()}`;
    await a.getByLabel("Name").fill(name);
    // RadioGroup defaults to "public" — leave as-is.
    await a.getByRole("button", { name: /^create$/i }).click();

    // After creation the app navigates to /channels/<uuid>. Capture the id to
    // register it for cleanup via the shared api client.
    await a.waitForURL(/\/channels\/[a-f0-9-]{36}$/, { timeout: 10000 });
    const channelId = a.url().match(/\/channels\/([a-f0-9-]{36})$/)?.[1];
    if (!channelId) {
      throw new Error(`could not extract channel id from URL: ${a.url()}`);
    }
    api.trackChannel(channelId);

    // Tab A confirms its own channel header is visible.
    await expect(
      a.locator("h1", { hasText: `# ${name}` }),
    ).toBeVisible({ timeout: 10000 });

    // Tab B's sidebar should show the new channel WITHOUT a refresh — this
    // proves channel:created → applyChannelEvent → channelKeys.list
    // invalidation works over Tab B's independent WS connection.
    // Generous timeout to cover WS round-trip + invalidation + refetch latency.
    await expect(
      b.locator("aside button", { hasText: `# ${name}` }).first(),
    ).toBeVisible({ timeout: 15000 });

    // Tab B clicks the new channel to open the same view.
    await b.locator("aside button", { hasText: `# ${name}` }).first().click();
    await b.waitForURL(new RegExp(`/channels/${channelId}$`));
    await expect(
      b.locator("h1", { hasText: `# ${name}` }),
    ).toBeVisible({ timeout: 5000 });

    // Tab A sends a message via the composer.
    const body = "realtime hello from A";
    await a.getByTestId("channel-composer-textarea").fill(body);
    await a.keyboard.press("Enter");

    // Tab A sees its own message immediately (optimistic insert).
    await expect(
      a.getByTestId("channel-message").last(),
    ).toContainText(body, { timeout: 5000 });

    // Tab B should see the message without a reload — proves
    // channel:message:created → applyChannelEvent → channelKeys.messages
    // invalidation works.
    await expect(
      b.getByTestId("channel-message").last(),
    ).toContainText(body, { timeout: 15000 });

    // Close both contexts to free browser resources.
    await ctxA.close();
    await ctxB.close();
  });
});
