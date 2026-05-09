import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Channels", () => {
  let api: TestApiClient;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);
  });

  test.afterEach(async () => {
    if (api) {
      await api.cleanup();
    }
  });

  test("create a channel, send a message, persist across reload", async ({ page }) => {
    // Dismiss the onboarding "Welcome — add starter tasks?" dialog if present.
    // It has no close button; click "Start blank workspace" to dismiss it.
    // Use a try/catch so we don't fail if it's already absent.
    try {
      const blankBtn = page.getByRole("button", {
        name: /start blank workspace/i,
      });
      await blankBtn.waitFor({ state: "visible", timeout: 5000 });
      await blankBtn.click();
      // Wait for the dialog overlay to go away before proceeding
      await page
        .locator('[data-slot="dialog-overlay"]')
        .waitFor({ state: "hidden", timeout: 5000 });
    } catch {
      // Dialog not present — continue
    }

    // Navigate to the Channels section via the sidebar link.
    await page.getByRole("link", { name: "Channels" }).click();
    await page.waitForURL("**/channels");

    // Open the create-channel dialog via the "+" button in the channel list sidebar.
    await page.getByRole("button", { name: /new channel/i }).click();

    // Fill in a unique channel name so reruns don't collide on the unique index.
    const name = `e2e-basic-${Date.now()}`;
    await page.getByLabel("Name").fill(name);

    // RadioGroup defaults to "public" — leave it as-is.
    await page.getByRole("button", { name: /^create$/i }).click();

    // After creation the app navigates to /channels/<id>.
    // Wait for the URL to settle, then register the channel for cleanup so
    // afterEach's api.cleanup() wipes the row (otherwise UI-created channels
    // accumulate across runs).
    await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/, { timeout: 10000 });
    const channelId = page.url().match(/\/channels\/([a-f0-9-]{36})$/)?.[1];
    if (!channelId) {
      throw new Error(`could not extract channel id from URL: ${page.url()}`);
    }
    api.trackChannel(channelId);

    // The header shows "# <name>" in an h1.
    await expect(
      page.locator("h1", { hasText: `# ${name}` }),
    ).toBeVisible({ timeout: 10000 });

    // Send a message via the composer.
    const body = "hello from playwright";
    await page.getByTestId("channel-composer-textarea").fill(body);
    await page.keyboard.press("Enter");

    // The message should appear in the message list after the optimistic insert settles.
    await expect(
      page.getByTestId("channel-message").last(),
    ).toContainText(body, { timeout: 8000 });

    // Reload — the message must still be visible (proves server persistence).
    await page.reload();
    await expect(
      page.getByTestId("channel-message").last(),
    ).toContainText(body, { timeout: 10000 });
  });
});
