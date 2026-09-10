import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function recipientThread(page: Page) {
  await signup(page, `recipients-${Date.now()}@rakazo.test`, "password12", "Scripted preview");
  await completeOnboarding(page);
  const mylo = await rpc<{ id: string }>(page, "bots/create", { name: "Mylo" });
  const sage = await rpc<{ id: string }>(page, "bots/create", { name: "Sage" });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Scripted recipient preview",
    botIds: [mylo.id, sage.id],
  });
  await page.evaluate(() => {
    localStorage.setItem("rakazo.presentation", "slack");
    localStorage.setItem("rakazo.uiAppearance", "light");
  });
  await page.goto(`/app/g/${group.id}`);
  const main = page.getByTestId("slack-message-canvas");
  await main.locator("textarea").fill("@Sage How is it going?");
  await main.locator("textarea").press("Enter");
  const panel = page.getByTestId("slack-thread-panel");
  const input = panel.locator("textarea");
  await expect(input).toHaveValue("@Sage ");
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const snapshot = await rpc<{ rootMessages: Array<{ id: string }> }>(page, "threads/get", {
    groupId: group.id,
    includeRoots: true,
  });
  const rootId = snapshot.rootMessages[0]!.id;
  return { mylo, sage, group, panel, input, rootId };
}

test("thread recipient prefix is editable and never reinserted over a draft", async ({
  page,
}, testInfo) => {
  const { group, rootId, input, panel } = await recipientThread(page);
  await input.fill("@Mylo Your turn");
  await input.press("Enter");
  await expect(input).toHaveValue("@Mylo ");
  await input.fill("");
  await expect(panel.getByTestId("thread-recipient-hint")).toContainText("Mylo");
  // A real realtime update must not restore a prefix the user deleted.
  await rpc(page, "threads/send", {
    groupId: group.id,
    text: "@Mylo Realtime refresh",
    replyToMessageId: rootId,
    replyInThread: true,
  });
  await expect(panel).toContainText("Realtime refresh");
  await expect(input).toHaveValue("");
  await input.fill("Draft stays exactly here");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11));
  await expect(input).toHaveValue("Draft stays exactly here");
  await rpc(page, "threads/send", {
    groupId: group.id,
    text: "@Mylo Another refresh",
    replyToMessageId: rootId,
    replyInThread: true,
  });
  await expect(panel).toContainText("Another refresh");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([6, 11]);
  await input.fill("@Mylo ");
  await captureScreenshot(page, testInfo, "recipients-light-desktop");
  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.reload();
  await page
    .getByTestId("slack-message-canvas")
    .locator('[data-testid^="slack-thread-"]')
    .first()
    .click();
  await expect(input).toHaveValue("@Mylo ");
  await captureScreenshot(page, testInfo, "recipients-dark-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "recipients-dark-mobile");
});

test("everyone prefill matches the complete authoritative recipient set", async ({ page }) => {
  const { mylo, sage, group, rootId, input } = await recipientThread(page);
  await input.fill("@everyone Both agents please");
  await input.press("Enter");
  await expect
    .poll(async () =>
      (
        await rpc<{ recipientBotIds: string[] }>(page, "threads/replies", {
          groupId: group.id,
          rootMessageId: rootId,
        })
      ).recipientBotIds.sort(),
    )
    .toEqual([mylo.id, sage.id].sort());
  const audience = await rpc<{ recipientBotIds: string[] }>(page, "threads/replies", {
    groupId: group.id,
    rootMessageId: rootId,
  });
  const names = new Map([
    [mylo.id, "Mylo"],
    [sage.id, "Sage"],
  ]);
  await expect(input).toHaveValue(
    audience.recipientBotIds.map((id) => `@${names.get(id)} `).join(""),
  );
  await input.fill("@Mylo Back to one");
  await input.press("Enter");
  await expect(input).toHaveValue("@Mylo ");
});

test("multiword recipients preserve IME and newer drafts across delayed acknowledgement", async ({
  page,
}) => {
  const { mylo, rootId, input, panel } = await recipientThread(page);
  await input.fill("@Mylo Your turn");
  await input.press("Enter");
  await expect(input).toHaveValue("@Mylo ");
  await rpc(page, "bots/update", { botId: mylo.id, name: "Mylo Writer" });
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  await expect(input).toHaveValue("@Mylo Writer ");
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await input.fill("@Mylo Writer IME draft");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toHaveValue("@Mylo Writer IME draft");
  let fetched = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    const response = await route.fetch();
    fetched = true;
    await gate;
    await route.fulfill({ response });
  });
  await input.fill("@Mylo Writer Delayed acknowledgement");
  const acknowledged = page.waitForResponse((response) =>
    response.url().endsWith("/rpc/threads/send"),
  );
  await input.press("Enter");
  await expect.poll(() => fetched).toBe(true);
  await input.fill("A newer draft must survive");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 7));
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith("/rpc/threads/replies"),
  );
  release();
  await acknowledged;
  await refreshed;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(input).toHaveValue("A newer draft must survive");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([2, 7]);
  await page.unroute("**/rpc/threads/send");
});
