import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Channels threads", () => {
  let api: TestApiClient;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);
  });

  test.afterEach(async () => {
    if (api) await api.cleanup();
  });

  test("hovering a message exposes Reply, drawer shows parent and reply, count chip appears", async ({ page }) => {
    // Dismiss onboarding if present (mirrors channels-basic.spec.ts).
    try {
      const blank = page.getByRole("button", { name: /start blank workspace/i });
      await blank.waitFor({ state: "visible", timeout: 5000 });
      await blank.click();
      await page
        .locator('[data-slot="dialog-overlay"]')
        .waitFor({ state: "hidden", timeout: 5000 });
    } catch {
      /* not present — continue */
    }

    // Create a channel via the API to skip the dialog.
    const channel = await api.createChannel(`e2e-thread-${Date.now()}`);

    await page.goto(`/e2e-workspace/channels/${channel.id}`);
    await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/);

    // Send the parent message via the main composer.
    const parentBody = "thread parent " + Date.now();
    await page.getByTestId("channel-composer-textarea").fill(parentBody);
    await page.keyboard.press("Enter");

    // Find the parent row, hover to reveal Reply button, click it.
    const parentRow = page.getByTestId("channel-message").filter({ hasText: parentBody }).first();
    await parentRow.waitFor({ state: "visible", timeout: 10000 });
    await parentRow.hover();
    const replyBtn = parentRow.getByTestId("channel-message-reply-button");
    await replyBtn.click();

    // Drawer opens with parent inside.
    const drawer = page.getByTestId("channel-thread-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("channel-message").first()).toContainText(parentBody);

    // Send a reply via the thread composer.
    const replyBody = "thread reply " + Date.now();
    await drawer.getByTestId("thread-composer-textarea").fill(replyBody);
    await drawer.getByTestId("thread-composer-textarea").press("Enter");

    // Reply lands in the drawer's message list.
    await expect(
      drawer.getByTestId("channel-message").last(),
    ).toContainText(replyBody, { timeout: 10000 });

    // Reply-count chip appears on the parent row in the main timeline.
    await expect(
      parentRow.getByTestId("channel-message-reply-count"),
    ).toContainText(/1 repl/, { timeout: 10000 });

    // Close the drawer and reopen via the count chip — proves both entry
    // points open the same drawer.
    await drawer.getByRole("button", { name: /close thread/i }).click();
    await expect(drawer).toBeHidden();
    await parentRow.getByTestId("channel-message-reply-count").click();
    await expect(page.getByTestId("channel-thread-drawer")).toBeVisible();
  });
});
