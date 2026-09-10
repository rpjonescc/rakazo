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
  await expect(panel.locator('[data-testid="mention-chip"]')).toHaveText("Sage");
  await expect(input).toHaveValue("");
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
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  await input.fill("@Mylo");
  await panel.getByRole("option", { name: "@Mylo", exact: true }).click();
  await input.fill("Your turn");
  await input.press("Enter");
  await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo");
  await expect(input).toHaveValue("");
  await panel.getByRole("button", { name: "Remove mention Mylo", exact: true }).click();
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
  await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo");
  await expect(input).toHaveValue("");
  await captureScreenshot(page, testInfo, "recipients-dark-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "recipients-dark-mobile");
});

test("sent recipient chips persist in the main and thread transcript", async ({
  page,
}, testInfo) => {
  const { sage, rootId, panel, input, group } = await recipientThread(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .getByTestId("slack-message-canvas")
    .getByTestId("message-user-bubble")
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("@Sage How is it going?");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const automatic = await panel
    .getByTestId("mention-chip")
    .evaluate((el) => el.outerHTML.replace(/spin-grad-[^")]+/g, "spin-grad-instance"));
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  await input.pressSequentially("@Sage");
  await panel.getByRole("option", { name: "@Sage", exact: true }).click();
  expect(
    await panel
      .getByTestId("mention-chip")
      .evaluate((el) => el.outerHTML.replace(/spin-grad-[^")]+/g, "spin-grad-instance")),
  ).toBe(automatic);
  await input.pressSequentially("A real typed followup");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const reply = await rpc<{
    recipientBotIds: string[];
    messages: Array<{
      id: string;
      role: string;
      blocks: Array<{ kind: string; text?: string; mentions?: Array<{ id: string }> }>;
    }>;
  }>(page, "threads/replies", { groupId: group.id, rootMessageId: rootId });
  expect(reply.recipientBotIds).toEqual([sage.id]);
  const sent = reply.messages.find(
    (message) =>
      message.role === "user" &&
      message.blocks.some((block) => block.text?.includes("A real typed followup")),
  )!;
  expect(sent.blocks[0]!.mentions?.[0]?.id).toBe(sage.id);
  await rpc(page, "bots/update", { botId: sage.id, name: "Sage Renamed" });
  const main = page.getByTestId("slack-message-canvas");
  await expect(main.getByTestId("sent-mention-chip")).toHaveAttribute("data-mention-id", sage.id);
  await expect(panel.getByTestId("sent-mention-chip")).toHaveCount(2);
  await expect(panel.getByTestId("sent-mention-chip").getByRole("button")).toHaveCount(0);
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  await expect(main.getByTestId("sent-mention-chip")).toHaveText("@Sage");
  await expect(panel.getByTestId("sent-mention-chip")).toHaveText(["@Sage", "@Sage"]);
  await expect(panel.getByTestId("mention-chip")).toHaveText("Sage Renamed");
  await captureScreenshot(page, testInfo, "mention-chips-light-desktop");
  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  await captureScreenshot(page, testInfo, "mention-chips-dark-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  await expect(panel.getByTestId("mention-chip")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "mention-chips-dark-mobile");
});

test("literal prose, email, HTML and code remain text after reload", async ({ page }) => {
  const { group, rootId, panel, input } = await recipientThread(page);
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  const text =
    'Email person@Sage.example; discuss @Sage. <img src=x onerror="window.chipXss=true">\n```\n@Sage code\n```';
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const reply = await rpc<{
    messages: Array<{ role: string; blocks: Array<{ text?: string; mentions?: unknown[] }> }>;
  }>(page, "threads/replies", { groupId: group.id, rootMessageId: rootId });
  expect(
    reply.messages.find((message) => message.role === "user" && message.blocks[0]?.text === text)
      ?.blocks[0]?.mentions,
  ).toEqual([]);
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  const bubble = panel.getByTestId("message-user-bubble").filter({ hasText: "Email person" });
  await expect(bubble).toHaveText(text);
  await expect(bubble.getByTestId("sent-mention-chip")).toHaveCount(0);
  await expect(bubble.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "chipXss"))).toBeUndefined();
});

test("everyone prefill matches the complete authoritative recipient set", async ({ page }) => {
  const { mylo, sage, group, rootId, input, panel } = await recipientThread(page);
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  await input.fill("@everyone Both agents please");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel
    .getByTestId("message-user-bubble")
    .filter({ hasText: "Both agents please" })
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "@everyone Both agents please",
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
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
  await expect(panel.getByTestId("mention-chip")).toHaveText(
    audience.recipientBotIds.map((id) => names.get(id)!),
  );
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  await input.fill("@Mylo Back to one");
  await input.press("Enter");
  await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo");
  await expect(input).toHaveValue("");
});

test("a chip selection made during delayed acknowledgement survives", async ({ page }) => {
  const { panel, input } = await recipientThread(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetched = false;
  await page.route("**/rpc/threads/send", async (route) => {
    const response = await route.fetch();
    fetched = true;
    await gate;
    await route.fulfill({ response });
  });
  await input.fill("Delayed chip edit");
  await input.press("Enter");
  try {
    await expect.poll(() => fetched).toBe(true);
    await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith("/rpc/threads/replies"),
    );
    release();
    await refreshed;
    await expect(panel.getByTestId("mention-chip")).toHaveCount(0);
    await expect(input).toHaveValue("Delayed chip edit");
    await input.fill("@Mylo");
    await panel.getByRole("option", { name: "@Mylo", exact: true }).click();
    await input.dispatchEvent("keydown", { key: "Backspace", isComposing: true });
    await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo");
    await input.press("Backspace");
    await expect(panel.getByTestId("mention-chip")).toHaveCount(0);
  } finally {
    release();
    await page.unroute("**/rpc/threads/send");
  }
});

test("multiword recipients preserve IME and newer drafts across delayed acknowledgement", async ({
  page,
}) => {
  const { mylo, rootId, input, panel } = await recipientThread(page);
  await panel.getByRole("button", { name: "Remove mention Sage", exact: true }).click();
  await input.fill("@Mylo");
  await panel.getByRole("option", { name: "@Mylo", exact: true }).click();
  await input.fill("Your turn");
  await input.press("Enter");
  await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo");
  await expect(input).toHaveValue("");
  await rpc(page, "bots/update", { botId: mylo.id, name: "Mylo Writer" });
  await page.reload();
  await page.getByTestId(`slack-thread-${rootId}`).click();
  await expect(panel.getByTestId("mention-chip")).toHaveText("Mylo Writer");
  await expect(input).toHaveValue("");
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
