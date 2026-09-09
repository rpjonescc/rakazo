import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type Message = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Array<{ kind: string; text?: string }>;
  createdAt: string;
};
type Snapshot = { threadId: string; messages: Message[] };

async function setup(page: import("@playwright/test").Page) {
  await signup(page, `slack-compat-${Date.now()}@rakazo.test`, "password12", "Slack compatibility");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const toggle = page.getByTestId("presentation-mode-toggle");
  if (!(await toggle.isVisible())) {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  }
  await toggle.click();
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  return botId;
}

test("Slack never offers durable reply actions on transient subagent rows", async ({
  page,
}, testInfo) => {
  const botId = await setup(page);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const hydrateRpc = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;
  await page.route(hydrateRpc, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const thread = body.json?.thread ?? body.json;
    if (thread?.messages) {
      thread.messages.push({
        id: "subagent:compatibility-probe",
        threadId: snapshot.threadId,
        seq: 999999,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Transient subagent compatibility probe" }],
        createdAt: new Date().toISOString(),
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const row = page.locator('[data-message-id="subagent:compatibility-probe"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("slack-thread-subagent:compatibility-probe")).toHaveCount(0);
  await expect(row.getByTestId("message-hover-actions")).toHaveCount(0);
  const durable = page.getByTestId("slack-message-canvas").locator("[data-message-id]").first();
  await expect(durable.locator('[data-testid^="slack-thread-"]')).toHaveCount(1);
  await captureScreenshot(page, testInfo, "slack-transient-actions-desktop");
});

test("Slack ignores a late previous-root response and disables failed-root composer", async ({
  page,
}, testInfo) => {
  const botId = await setup(page);
  await rpc(page, "threads/send", { botId, text: "Second durable root for selection" });
  await expect
    .poll(async () => {
      const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
      return snapshot.messages.length;
    })
    .toBeGreaterThan(1);
  await rpc(page, "threads/stop", { botId });
  await page.reload();
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const roots = snapshot.messages.filter(
    (m) => !m.id.startsWith("progress:") && !m.id.startsWith("subagent:"),
  );
  const rootA = roots[0]!;
  const rootB = roots.find((m) =>
    m.blocks.some((b) => b.text === "Second durable root for selection"),
  )!;
  expect(rootA.id).not.toBe(rootB.id);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  let released = false;
  let fulfilled = 0;
  let failB = false;
  await page.route("**/rpc/threads/replies", async (route) => {
    const rootId = route.request().postDataJSON().json.rootMessageId;
    if (rootId === rootB.id && failB) {
      await route.fulfill({ status: 503, json: { message: "Controlled reply-page failure" } });
      return;
    }
    const response = await route.fetch();
    if (rootId === rootA.id && !released) {
      requests += 1;
      await gate;
      await route.fulfill({ response });
      fulfilled += 1;
      return;
    }
    await route.fulfill({ response });
  });
  await page.getByTestId(`slack-thread-${rootA.id}`).click();
  await expect.poll(() => requests).toBeGreaterThan(0);
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel).toContainText("Loading replies");
  await expect(panel.locator("textarea")).toHaveCount(0);
  await page.getByTestId(`slack-thread-${rootB.id}`).click();
  await expect(panel.locator("textarea")).toBeEnabled();
  await expect(panel.locator(`[data-message-id="${rootB.id}"]`)).toBeVisible();
  released = true;
  release();
  await expect.poll(() => fulfilled).toBe(requests);
  await expect(panel.locator(`[data-message-id="${rootA.id}"]`)).toHaveCount(0);
  await expect(panel.locator("textarea")).toBeEnabled();
  failB = true;
  await page.getByTestId(`slack-thread-${rootA.id}`).click();
  await expect(panel.locator("textarea")).toBeEnabled();
  await page.getByTestId(`slack-thread-${rootB.id}`).click();
  await expect(panel.locator("textarea")).toBeDisabled();
  await expect(panel).toContainText(/error|failed|unavailable|Controlled/i);
  await captureScreenshot(page, testInfo, "slack-failed-root-disabled");
  failB = false;
  await page.getByTestId(`slack-thread-${rootB.id}`).click();
  await expect(panel.locator("textarea")).toBeEnabled();
  await captureScreenshot(page, testInfo, "slack-selected-root-recovered");
});

test("Slack retains an earlier page when a realtime head finishes first", async ({ page }) => {
  const botId = await setup(page);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const root = snapshot.messages[0]!;
  const message = (seq: number) => ({
    ...root,
    id: `race-message-${seq}`,
    seq,
    role: "user",
    threadRootMessageId: root.id,
    blocks: [{ kind: "text", text: `Race reply ${seq}` }],
  });
  let version = 100;
  let olderStarted = false;
  let latestHeadApplied = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/replies", async (route) => {
    const before = route.request().postDataJSON().json.before;
    const result = {
      threadId: snapshot.threadId,
      rootMessage: root,
      messages: Array.from({ length: 50 }, (_, index) =>
        message(before ? index + 1 : version - 49 + index),
      ),
      olderCursor: before ? null : version - 49,
      replyCount: version,
    };
    if (before) {
      olderStarted = true;
      await gate;
    }
    await route.fulfill({ json: { json: result } });
    if (!before && result.replyCount === 101) latestHeadApplied = true;
  });
  await page.getByTestId(`slack-thread-${root.id}`).click();
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel).toContainText("Race reply 100");
  await panel.getByRole("button", { name: "Load earlier messages" }).click();
  await expect.poll(() => olderStarted).toBe(true);
  version = 101;
  await rpc(page, "threads/send", { botId, text: "Trigger authoritative realtime head refresh" });
  await expect.poll(() => latestHeadApplied).toBe(true);
  await expect(panel).toContainText("Race reply 101");
  release();
  await expect(panel).toContainText("Race reply 1", { useInnerText: true });
  await expect(panel.locator('[data-message-id="race-message-1"]')).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  await expect(panel).toContainText("101 replies");
});

test("Slack applies a pending realtime head after a newer history request completes", async ({
  page,
}) => {
  const botId = await setup(page);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const root = snapshot.messages[0]!;
  const message = (seq: number) => ({
    ...root,
    id: `reverse-race-${seq}`,
    seq,
    role: "user",
    threadRootMessageId: root.id,
    blocks: [{ kind: "text", text: `Reverse race reply ${seq}` }],
  });
  let version = 100;
  let heldHeads = 0;
  let releasedHeads = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/replies", async (route) => {
    const before = route.request().postDataJSON().json.before;
    const result = {
      threadId: snapshot.threadId,
      rootMessage: root,
      messages: Array.from({ length: 50 }, (_, index) =>
        message(before ? index + 1 : version - 49 + index),
      ),
      olderCursor: before ? null : version - 49,
      replyCount: before ? 100 : version,
    };
    if (!before && version === 101) {
      heldHeads += 1;
      await gate;
      await route.fulfill({ json: { json: result } });
      releasedHeads += 1;
      return;
    }
    await route.fulfill({ json: { json: result } });
  });
  await page.getByTestId(`slack-thread-${root.id}`).click();
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel).toContainText("Reverse race reply 100");
  version = 101;
  await rpc(page, "threads/send", { botId, text: "Hold latest authoritative realtime reply head" });
  await rpc(page, "threads/stop", { botId });
  await expect.poll(() => heldHeads).toBeGreaterThan(0);
  await panel.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(panel.locator('[data-message-id="reverse-race-1"]')).toHaveCount(1);
  release();
  await expect.poll(() => releasedHeads).toBeGreaterThan(0);
  await expect(panel.locator('[data-message-id="reverse-race-101"]')).toHaveCount(1);
  await expect(panel).toContainText("101 replies");
  await expect(panel.locator('[data-message-id="reverse-race-1"]')).toHaveCount(1);
});

test.describe("Slack mobile web compatibility", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("touch thread, composer, navigation and Classic share persisted content", async ({
    page,
  }, testInfo) => {
    const botId = await setup(page);
    const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
    const root = snapshot.messages[0]!;
    const row = page.locator(`[data-message-id="${root.id}"]`);
    await row.scrollIntoViewIfNeeded();
    const more = row.getByRole("button", { name: "More", exact: true });
    await expect(more).toBeVisible();
    await more.tap();
    await page.getByRole("menuitem", { name: "Reply", exact: true }).tap();
    const panel = page.getByTestId("slack-thread-panel");
    await expect(panel.locator("textarea")).toBeEnabled();
    await panel.locator("textarea").fill("Mobile branch compatibility reply");
    await panel.locator("textarea").press("Enter");
    await expect(panel).toContainText("Mobile branch compatibility reply");
    expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBe(390);
    await captureScreenshot(page, testInfo, "slack-mobile-thread");
    await page.reload();
    await expect(page.getByTestId("slack-workspace")).toBeVisible();
    await page.getByTestId(`slack-thread-${root.id}`).tap();
    await expect(panel).toContainText("Mobile branch compatibility reply");
    await captureScreenshot(page, testInfo, "slack-mobile-thread-reloaded");
    await page.getByRole("button", { name: "Close thread", exact: true }).tap();
    await page.getByRole("button", { name: "Open Slack navigation", exact: true }).tap();
    await page.getByTestId("slack-view-toggle").tap();
    await expect(page.getByTestId("transcript")).toContainText("Mobile branch compatibility reply");
    await captureScreenshot(page, testInfo, "classic-mobile-same-branch");
  });
});
