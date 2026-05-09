import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Channels reactions", () => {
  let api: TestApiClient;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);
  });

  test.afterEach(async () => {
    if (api) await api.cleanup();
  });

  test("toggle reaction via picker, chip count updates, second click removes it", async ({ page }) => {
    // Onboarding dismissal (matches channels-basic.spec.ts).
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

    const channel = await api.createChannel(`e2e-react-${Date.now()}`);
    await page.goto(`/e2e-workspace/channels/${channel.id}`);
    await page.waitForURL(/\/channels\/[a-f0-9-]{36}$/);

    const body = "react to me " + Date.now();
    await page.getByTestId("channel-composer-textarea").fill(body);
    await page.keyboard.press("Enter");

    const row = page.getByTestId("channel-message").filter({ hasText: body }).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.hover();

    // Picker is hidden by default; the + button reveals it on hover.
    await row.getByTestId("channel-reaction-add").click();
    const picker = page.getByTestId("channel-reaction-picker");
    await expect(picker).toBeVisible();

    // Pick 🚀 from the quick-pick palette.
    await picker.getByRole("button", { name: "🚀" }).click();

    // Chip appears with count 1, marked as mine (aria-pressed=true).
    const chip = row.getByTestId("channel-reaction-chip").filter({ hasText: "🚀" });
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText("1");
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // Second click toggles off.
    await chip.click();
    await expect(chip).toBeHidden({ timeout: 10000 });
  });
});
