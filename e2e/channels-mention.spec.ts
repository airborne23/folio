import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Channels @mention", () => {
  let api: TestApiClient;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);
  });

  test.afterEach(async () => {
    if (api) await api.cleanup();
  });

  test("@mentioning an agent in a channel enqueues a task", async ({ page }) => {
    // Dismiss onboarding if present (matches channels-basic.spec.ts).
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

    // Seed a stub agent via direct DB insert (bypasses runtime_id requirement
    // of the REST API and works regardless of the running binary's agent-creation
    // handler version).
    const agentName = `c6agent${Date.now()}`;
    const agent = await api.createAgent(agentName);

    // Navigate to Channels.
    await page.getByRole("link", { name: "Channels" }).click();
    await page.waitForURL("**/channels");

    // Create a fresh public channel.
    await page.getByRole("button", { name: /new channel/i }).click();
    const channelName = `c6-mention-${Date.now()}`;
    await page.getByLabel("Name").fill(channelName);
    await page.getByRole("button", { name: /^create$/i }).click();
    await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/, { timeout: 10000 });

    const channelId = page.url().match(/\/channels\/([a-f0-9-]{36})$/)?.[1];
    if (!channelId) throw new Error(`could not extract channel id from URL: ${page.url()}`);
    api.trackChannel(channelId);

    // Add the agent to the channel via direct DB insert so we don't depend on
    // the running server binary's agent-member support status. The channel
    // dispatcher reads channel_member rows at dispatch time; this is equivalent
    // to the UI "Add agent" flow (which also calls UpsertChannelMember).
    await api.addAgentToChannel(channelId, agent.id);

    // Send a message mentioning the agent. The agent name uses only alphanumeric
    // characters (no hyphens) to guarantee the @mention regex in ANY binary
    // version captures the full token.
    const body = `@${agentName} hello agent`;
    await page.getByTestId("channel-composer-textarea").fill(body);
    await page.keyboard.press("Enter");

    // Assert the human message lands in the timeline.
    await expect(page.getByTestId("channel-message").last()).toContainText(
      body,
      { timeout: 10000 },
    );

    // Assert a HIGH-priority task was enqueued for the mentioned agent in this
    // channel. We poll briefly to give the server-side mention-dispatch a moment
    // to commit.
    let found: { agent_id: string; priority: number } | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const tasks = await api.listChannelTasks(channelId);
      found = tasks.find((t) => t.agent_id === agent.id);
      if (found) break;
      await page.waitForTimeout(500);
    }
    expect(found, "expected an enqueued task for the mentioned agent").toBeTruthy();
    expect(found!.priority).toBeGreaterThanOrEqual(100); // HIGH per C.2 dispatcher
  });

  // FIXME: streaming reply path (Prepare → Append → Finalize → channel:message:patched)
  // requires a live daemon to claim the task. The Go-side query tests at
  // server/internal/handler/channel_test.go (TestStreaming_*) already cover
  // the data-layer transitions. End-to-end streaming is parked alongside B.4's
  // realtime-fanout fixme and will be addressed once the WS delivery path is
  // diagnosed in the next sweep.
  test.fixme("agent streams a reply that appears in the timeline", async () => {});
});
