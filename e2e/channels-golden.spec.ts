import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

// Golden-path test: a single user journey that exercises the full channels
// surface end-to-end — channel creation, agent membership, @mention task
// dispatch, thread reply with rollup, and reaction toggle. If any of these
// individual flows regress, this test fails alongside the focused specs.
test.describe("Channels golden path", () => {
  let api: TestApiClient;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);
  });

  test.afterEach(async () => {
    if (api) await api.cleanup();
  });

  test("create → add agent → mention → thread reply → react", async ({ page }) => {
    // Onboarding dismissal.
    try {
      const blank = page.getByRole("button", { name: /start blank workspace/i });
      await blank.waitFor({ state: "visible", timeout: 5000 });
      await blank.click();
      await page
        .locator('[data-slot="dialog-overlay"]')
        .waitFor({ state: "hidden", timeout: 5000 });
    } catch {
      /* not present */
    }

    // --- Step 1: create channel via the dialog (exercises sidebar + create flow). ---
    const stub = await api.createAgent(`golden-agent-${Date.now()}`);
    await page.getByRole("link", { name: "Channels" }).click();
    await page.waitForURL("**/channels");
    await page.getByRole("button", { name: /new channel/i }).click();

    const channelName = `golden-${Date.now()}`;
    await page.getByLabel("Name").fill(channelName);
    await page.getByRole("button", { name: /^create$/i }).click();
    await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/, { timeout: 10000 });
    const channelId = page.url().match(/\/channels\/([a-f0-9-]{36})$/)?.[1];
    if (!channelId) throw new Error(`could not extract channel id: ${page.url()}`);
    api.trackChannel(channelId);

    // --- Step 2: add agent via direct DB insert (UI flow tested in C.5). ---
    await api.addAgentToChannel(channelId, stub.id);

    // --- Step 3: send a message that @mentions the agent — task dispatches. ---
    const triggerBody = `@${stub.name} please pick this up`;
    await page.getByTestId("channel-composer-textarea").fill(triggerBody);
    await page.keyboard.press("Enter");

    const triggerRow = page.getByTestId("channel-message").filter({ hasText: triggerBody }).first();
    await triggerRow.waitFor({ state: "visible", timeout: 10000 });

    // Task lands on the queue with HIGH priority (proves dispatcher fired).
    let task: { agent_id: string; priority: number } | undefined;
    for (let i = 0; i < 10; i++) {
      const tasks = await api.listChannelTasks(channelId);
      task = tasks.find((t) => t.agent_id === stub.id);
      if (task) break;
      await page.waitForTimeout(500);
    }
    expect(task, "expected an enqueued task for the mentioned agent").toBeTruthy();
    expect(task!.priority).toBeGreaterThanOrEqual(100);

    // --- Step 4: open thread on the trigger, post a reply, count chip updates. ---
    await triggerRow.hover();
    await triggerRow.getByTestId("channel-message-reply-button").click();
    const drawer = page.getByTestId("channel-thread-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("thread-composer-textarea").fill("first reply");
    await drawer.getByTestId("thread-composer-textarea").press("Enter");
    await expect(drawer.getByTestId("channel-message").last()).toContainText("first reply", {
      timeout: 10000,
    });
    await expect(triggerRow.getByTestId("channel-message-reply-count")).toContainText(/1 repl/);

    // Close drawer so the next interaction targets the main timeline cleanly.
    await drawer.getByRole("button", { name: /close thread/i }).click();
    await expect(drawer).toBeHidden();

    // --- Step 5: react to the trigger message via the picker. ---
    await triggerRow.hover();
    await triggerRow.getByTestId("channel-reaction-add").click();
    await page.getByTestId("channel-reaction-picker").getByRole("button", { name: "🚀" }).click();
    const chip = triggerRow.getByTestId("channel-reaction-chip").filter({ hasText: "🚀" });
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });
});
