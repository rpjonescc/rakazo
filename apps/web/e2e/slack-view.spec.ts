import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

type ThreadSnapshot = {
  threadId: string;
  messages: Array<{
    id: string;
    role: string;
    threadRootMessageId?: string;
    blocks: Array<{ kind: string; text?: string }>;
  }>;
};

test("optional Slack workspace preserves navigation, threads, and themes", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `slack-view-${stamp}@rakazo.test`, "password12", "Slack View");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const secondBotId = await createNamedBot(page, "Sage");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Planning",
    botIds: [firstBotId, secondBotId],
  });

  await page.goto(`/app/${firstBotId}`);
  await page.evaluate(() => {
    localStorage.setItem("rakazo.presentation", "slack");
    localStorage.setItem("rakazo.uiAppearance", "light");
  });
  await page.reload();

  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  await expect(page.getByTestId("slack-channel-list")).toContainText("Planning");
  await expect(page.getByTestId("slack-dm-list")).toContainText("Sage");
  await page.getByTestId(`slack-dm-${secondBotId}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${secondBotId}$`));
  await page.getByTestId(`slack-channel-${group.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}$`));
  await expect(page.getByTestId("slack-channel-intro")).toContainText("Sage");
  const composer = page.getByTestId("composer-bar");
  expect(
    await composer.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(110);
  expect(await composer.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("9px");

  await page.goto(`/app/${firstBotId}`);
  const sent = await rpc<{ runId: string }>(page, "threads/send", {
    botId: firstBotId,
    text: "Slack thread root",
  });
  let root: ThreadSnapshot["messages"][number] | undefined;
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: firstBotId });
        root = snapshot.messages.find(
          (message) =>
            message.role === "user" &&
            message.blocks.some(
              (block) => block.kind === "text" && block.text === "Slack thread root",
            ),
        );
        return root;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  expect(sent.runId).toBeTruthy();
  expect(root).toBeDefined();

  await rpc(page, "threads/stop", { botId: firstBotId });
  await rpc(page, "threads/send", {
    botId: firstBotId,
    text: "Slack thread reply",
    replyToMessageId: root!.id,
    replyInThread: true,
  });
  // Bury the root beyond a full raw transcript page: replies must not make
  // the channel canvas look empty on reload.
  for (let index = 0; index < 105; index++) {
    await rpc(page, "threads/stop", { botId: firstBotId });
    await rpc(page, "threads/send", {
      botId: firstBotId,
      text: `History reply ${index}`,
      replyToMessageId: root!.id,
      replyInThread: true,
    });
  }
  await rpc(page, "threads/stop", { botId: firstBotId });
  await page.reload();
  await expect(page.getByTestId(`slack-thread-${root!.id}`)).toContainText(/repl(y|ies)/);
  await page.getByTestId(`slack-thread-${root!.id}`).click();
  await expect(page.getByTestId("slack-thread-panel")).toBeVisible();
  const thread = page.getByTestId("slack-thread-panel");
  await expect(thread.locator("textarea")).toHaveAttribute("placeholder", "Reply in thread");
  await expect(thread.getByTestId("reply-parent-preview")).toHaveCount(0);
  await expect(thread.locator(`[data-message-id="${root!.id}"]`)).toHaveCount(1);
  await expect(thread.getByRole("button", { name: "Back to original message" })).toBeVisible();
  await thread.getByRole("button", { name: "Load earlier messages" }).click();
  await thread.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(thread).toContainText("Slack thread reply");
  await thread.locator("textarea").fill("Reply sent from the thread composer");
  await thread.locator("textarea").press("Enter");
  await expect(thread).toContainText("Reply sent from the thread composer");
  await expect(thread).toContainText("Slack thread reply");
  await expect(page.getByTestId("slack-message-canvas")).not.toContainText(
    "Reply sent from the thread composer",
  );
  const persisted = await rpc<{ messages: ThreadSnapshot["messages"] }>(page, "threads/replies", {
    botId: firstBotId,
    rootMessageId: root!.id,
  });
  expect(
    persisted.messages.some(
      (message) =>
        message.threadRootMessageId === root!.id &&
        message.blocks.some((block) => block.text === "Reply sent from the thread composer"),
    ),
  ).toBe(true);

  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  await expect(page.getByTestId("slack-channel-list")).toContainText("Planning");
  await page.getByTestId("slack-view-toggle").click();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await page.getByTestId("presentation-mode-toggle").click();
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
});
