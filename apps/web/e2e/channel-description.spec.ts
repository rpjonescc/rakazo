import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`channel creation and editing persist optional agent context at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await signup(
      page,
      `channel-description-${Date.now()}@rakazo.test`,
      "password12",
      "Scripted preview",
    );
    await completeOnboarding(page);
    const botId = activeBotId(page);
    await page.evaluate(() => {
      localStorage.setItem("rakazo.presentation", "slack");
      localStorage.setItem("rakazo.uiAppearance", "light");
    });
    await page.reload();
    if (width < 768) {
      await page.getByRole("button", { name: "Open Slack navigation", exact: true }).click();
    }
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await captureScreenshot(page, testInfo, "channel-create-before-or-after");
    const form = page.getByTestId("channel-create-form");
    await expect(form.getByRole("heading", { name: "New channel" })).toBeVisible();
    await expect(form).toContainText("Agents (pick 1–6)");
    await expect(form).toContainText("You (included)");
    await form.getByLabel("Name", { exact: true }).fill("Research planning");
    const description = form.getByLabel("Description (optional)");
    await expect(description).toHaveAttribute("maxlength", "4000");
    await description.fill("Plan research, compare evidence, and prepare a concise weekly brief.");
    await expect(form).toContainText(
      "Agents receive this context when they run in this channel, including threads.",
    );
    await form.locator('button[aria-pressed="false"]').first().click();
    await captureScreenshot(page, testInfo, "channel-create-description-light");
    const formBox = await form.boundingBox();
    expect(formBox!.x).toBeGreaterThanOrEqual(0);
    expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(width);
    const submitBox = await form
      .getByRole("button", { name: "Create channel", exact: true })
      .boundingBox();
    expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(844);
    await form.getByRole("button", { name: "Create channel", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/g\//);
    await expect(
      page.getByRole("button", { name: "Close Slack navigation", exact: true }),
    ).toHaveCount(0);
    const groupId = page.url().split("/g/")[1]!;
    const read = () =>
      rpc<{ description: string; members: Array<{ botId: string }> }>(page, "groups/get", {
        groupId,
      });
    expect(await read()).toMatchObject({
      description: "Plan research, compare evidence, and prepare a concise weekly brief.",
    });
    await page.reload();
    const intro = page.getByTestId("slack-channel-intro");
    await expect(intro).toContainText("Plan research, compare evidence");
    await expect(intro).not.toContainText("8yYiXV");
    await captureScreenshot(page, testInfo, "channel-description-light");
    await page.getByRole("button", { name: "Conversation settings", exact: true }).click();
    const settings = page.getByTestId("channel-settings-form");
    await expect(settings).toContainText("Agents (1–6)");
    await expect(settings).toContainText("You (included)");
    await settings.getByLabel("Description (optional)").fill("Unsaved draft");
    await settings.getByRole("button", { name: "Cancel edits", exact: true }).click();
    await expect(settings).not.toBeVisible();
    expect((await read()).description).toBe(
      "Plan research, compare evidence, and prepare a concise weekly brief.",
    );
    await page.getByRole("button", { name: "Conversation settings", exact: true }).click();
    await settings
      .getByLabel("Description (optional)")
      .fill("Updated shared purpose for the next run.");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings).not.toBeVisible();
    expect(await read()).toMatchObject({ description: "Updated shared purpose for the next run." });
    await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
    await page.reload();
    await expect(intro).toContainText("Updated shared purpose for the next run.");
    await captureScreenshot(page, testInfo, "channel-description-dark");
    await page.getByRole("button", { name: "Conversation settings", exact: true }).click();
    await captureScreenshot(page, testInfo, "channel-edit-description-dark");
    await settings.getByLabel("Description (optional)").fill("");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await page.reload();
    expect(await read()).toMatchObject({ description: "" });
    await expect(intro).toContainText("Start the conversation.");
    await expect(intro).not.toContainText("8yYiXV");
    await captureScreenshot(page, testInfo, "channel-no-description-dark");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    expect((await read()).members.map((member) => member.botId)).toContain(botId);
  });
}
