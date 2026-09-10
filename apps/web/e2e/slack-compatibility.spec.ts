import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type Message = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Array<{ kind: string; text?: string }>;
  runId?: string;
  createdAt: string;
};
type RootSummary = {
  rootMessageId: string;
  participantBotIds: string[];
  replyCount: number;
  state: string;
  runs: Array<{
    id: string;
    botId: string;
    taskId: string;
    status: string;
    error: string | null;
  }>;
};
type Snapshot = {
  threadId: string;
  messages: Message[];
  rootMessages?: Message[];
  rootSummaries?: RootSummary[];
};

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

test("Slack failure label contrast remains accessible in both themes", async ({ page }) => {
  const botId = await setup(page);
  const receipt = await rpc<{ messageId: string }>(page, "threads/send", {
    botId,
    text: "Fail this run for the failure contrast regression",
    conversationMode: "thread",
    clientNonce: `contrast-${Date.now()}`,
  });
  await expect
    .poll(async () => {
      const snapshot = await rpc<Snapshot>(page, "threads/get", { botId, includeRoots: true });
      return snapshot.rootSummaries?.find((root) => root.rootMessageId === receipt.messageId)
        ?.state;
    })
    .toBe("failed");
  await page.reload();
  await page.getByTestId(`slack-thread-${receipt.messageId}`).click();
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel.getByTestId("composer-error")).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", {
          name: theme === "dark" ? "Use dark mode" : "Use light mode",
          exact: true,
        })
        .click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const labels = [
      [
        "main status",
        page
          .getByTestId("slack-message-canvas")
          .getByTestId(`slack-root-status-${receipt.messageId}`),
      ],
      [
        "main failure",
        page
          .getByTestId("slack-message-canvas")
          .getByTestId(`slack-root-failure-${receipt.messageId}`),
      ],
      ["thread status", panel.getByTestId(`slack-root-status-${receipt.messageId}`)],
      ["thread failure", panel.getByTestId(`slack-root-failure-${receipt.messageId}`)],
      ["composer error", panel.getByTestId("composer-error").locator("span").first()],
    ] as const;
    for (const [part, element] of labels) {
      await expect(element).toBeVisible();
      const contrast = await element.evaluate((node) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context unavailable");
        const backgrounds: string[] = [];
        for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
          backgrounds.push(getComputedStyle(ancestor).backgroundColor);
        }
        context.fillStyle = "white";
        context.fillRect(0, 0, 1, 1);
        for (const color of backgrounds.reverse()) {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
        }
        const background = context.getImageData(0, 0, 1, 1).data;
        context.fillStyle = getComputedStyle(node).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = context.getImageData(0, 0, 1, 1).data;
        const luminance = (pixel: Uint8ClampedArray) =>
          [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
            const value = pixel[index]! / 255;
            return (
              sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        const levels = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
        return (levels[1]! + 0.05) / (levels[0]! + 0.05);
      });
      expect(contrast, `${theme} ${part} normal-size text contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("Slack autoopens channel and DM roots from their send receipts", async ({ page }) => {
  const botId = await setup(page);
  const secondBot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Receipt Sage",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const secondBotId = secondBot.id;
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Receipt planning",
    botIds: [botId, secondBotId],
  });

  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  const channelComposer = page.getByTestId("composer-bar").locator("textarea");
  await channelComposer.fill("Channel autoopen receipt");
  await channelComposer.press("Enter");
  const channelPanel = page.getByTestId("slack-thread-panel");
  await expect(channelPanel).toBeVisible();
  await expect(channelPanel).toContainText("Channel autoopen receipt");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(
          active instanceof HTMLTextAreaElement &&
            active.closest('[data-testid="slack-thread-panel"]'),
        );
      }),
    )
    .toBe(true);
  await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}$`));
  await page.getByRole("button", { name: "Back to channel", exact: true }).click();
  await expect(channelPanel).toHaveCount(0);
});

test("Slack autoopens direct-message roots from their send receipts", async ({ page }) => {
  const botId = await setup(page);
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("slack-workspace")).toBeVisible();
  await expect(page.getByTestId(`slack-dm-${botId}`)).toHaveAttribute("aria-current", "page");
  const dmComposer = page.getByTestId("composer-bar").locator("textarea");
  await expect(dmComposer).toBeEnabled();
  await dmComposer.fill("DM autoopen receipt");
  await dmComposer.press("Enter");
  await expect(page.getByTestId("slack-thread-panel")).toBeVisible();
  await expect(page.getByTestId("slack-thread-panel")).toContainText("DM autoopen receipt");
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
});

test("Slack keeps a failed root visible with participants and selected-root controls", async ({
  page,
}, testInfo) => {
  const botId = await setup(page);
  const first = await rpc<{ messageId: string }>(page, "threads/send", {
    botId,
    text: "Visible active root",
    conversationMode: "thread",
    clientNonce: `ui-status-first-${Date.now()}`,
  });
  await rpc(page, "threads/stop", { botId, rootMessageId: first.messageId });
  const second = await rpc<{ messageId: string; runId: string }>(page, "threads/send", {
    botId,
    text: "Visible failed root",
    conversationMode: "thread",
    clientNonce: `ui-status-second-${Date.now()}`,
  });
  await rpc(page, "threads/stop", { botId, rootMessageId: second.messageId });

  const summary: RootSummary[] = [
    {
      rootMessageId: first.messageId,
      participantBotIds: [botId],
      replyCount: 2,
      state: "running",
      runs: [
        {
          id: "ui-status-run-a",
          botId,
          taskId: "ui-status-task-a",
          status: "running",
          error: null,
        },
      ],
    },
    {
      rootMessageId: second.messageId,
      participantBotIds: [botId],
      replyCount: 1,
      state: "failed",
      runs: [
        {
          id: second.runId,
          botId,
          taskId: "ui-status-task-b",
          status: "failed",
          error: "Fake provider rejected this root",
        },
      ],
    },
  ];
  const hydrateRpc = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;
  await page.route(hydrateRpc, async (route) => {
    const response = await route.fetch();
    const body = JSON.parse(await response.text()) as { json?: Snapshot & { thread?: Snapshot } };
    const payload = body.json;
    const thread = payload?.thread ?? payload;
    if (thread) thread.rootSummaries = summary;
    if (payload?.thread) payload.thread = thread;
    else if (thread) body.json = thread;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.reload();
  await expect(page.getByTestId(`slack-root-status-${first.messageId}`)).toHaveText("Working");
  await expect(page.getByTestId(`slack-root-participants-${first.messageId}`)).toContainText(
    "Chief",
  );
  await expect(page.getByTestId(`slack-root-failure-${second.messageId}`)).toContainText(
    "Fake provider rejected this root",
  );

  const stopPayloads: Array<{ rootMessageId?: string }> = [];
  await page.route("**/rpc/threads/stop", async (route) => {
    stopPayloads.push(route.request().postDataJSON().json);
    await route.continue();
  });
  await page.getByTestId(`slack-root-stop-${first.messageId}`).click();
  await expect.poll(() => stopPayloads.length).toBe(1);
  expect(stopPayloads[0]?.rootMessageId).toBe(first.messageId);
  expect(stopPayloads.some((payload) => payload.rootMessageId === second.messageId)).toBe(false);

  await page.route("**/rpc/threads/replies", async (route) => {
    const request = route.request().postDataJSON() as { json?: { rootMessageId?: string } };
    if (request.json?.rootMessageId !== second.messageId) {
      await route.continue();
      return;
    }
    const response = await page.request.post(
      new URL("/rpc/threads/replies", page.url()).toString(),
      { data: request },
    );
    const body = (await response.json()) as {
      json?: { rootMessage?: { id?: string }; rootSummary?: RootSummary };
    };
    if (body.json) body.json.rootSummary = summary[1];
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.getByTestId(`slack-thread-${second.messageId}`).click();
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel.getByTestId(`slack-root-status-${second.messageId}`)).toHaveText("Failed");
  await expect(panel.getByTestId(`slack-root-failure-${second.messageId}`)).toContainText(
    "Fake provider rejected this root",
  );
  await expect(panel.getByTestId(`slack-root-retry-${second.messageId}`)).toBeVisible();
  const retryPayloads: Array<Record<string, unknown>> = [];
  await page.route("**/rpc/threads/send", async (route) => {
    const payload = route.request().postDataJSON() as { json?: Record<string, unknown> };
    retryPayloads.push(payload.json ?? {});
    await route.continue();
  });
  await panel.getByTestId(`slack-root-retry-${second.messageId}`).click();
  await expect.poll(() => retryPayloads.length).toBe(1);
  expect(retryPayloads[0]?.replyToMessageId).toBe(second.messageId);
  expect(retryPayloads[0]?.replyInThread).toBe(true);
  expect(retryPayloads[0]?.conversationMode).toBeUndefined();
  expect(retryPayloads[0]?.retryRunId).toBe(second.runId);
  const persisted = await rpc<Snapshot>(page, "threads/get", { botId, includeRoots: true });
  const sameTextRoots = (persisted.rootMessages ?? []).filter((message) =>
    message.blocks.some((block) => block.text === "Visible failed root"),
  );
  expect(sameTextRoots).toHaveLength(1);
  const replies = await rpc<{ messages: Message[] }>(page, "threads/replies", {
    botId,
    rootMessageId: second.messageId,
  });
  expect(replies.rootMessage.blocks.some((block) => block.text === "Visible failed root")).toBe(
    true,
  );
  await captureScreenshot(page, testInfo, "slack-root-status-failure-desktop");
  // Assertions are complete; ignore only mocks still in flight during teardown.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Slack preserves the draft after a busy send rejection", async ({ page }) => {
  await setup(page);
  await page.route("**/rpc/threads/send", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "CONFLICT",
          status: 409,
          message: "Conversation is busy",
        },
      }),
    });
  });
  const draft = "Keep this draft after busy";
  const textarea = page.getByTestId("composer-bar").locator("textarea");
  await textarea.fill(draft);
  await textarea.press("Enter");
  await expect(page.getByTestId("composer-error")).toContainText("Conversation is busy");
  await expect(textarea).toHaveValue(draft);
});

test("Slack response-loss retry reuses one intent and creates one root", async ({ page }) => {
  const botId = await setup(page);
  let loseNext = true;
  let sendRequests = 0;
  await page.route("**/rpc/threads/send", async (route) => {
    sendRequests += 1;
    if (loseNext) {
      loseNext = false;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const text = "One root after lost response";
  const textarea = page.getByTestId("composer-bar").locator("textarea");
  await textarea.fill(text);
  await textarea.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(textarea).toHaveValue(text);
  await textarea.press("Enter");
  await expect(page.getByTestId("slack-thread-panel")).toBeVisible();
  await expect(page.getByTestId("slack-thread-panel")).toContainText(text);
  await expect.poll(() => sendRequests).toBe(2);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const matching = snapshot.messages.filter((message) =>
    message.blocks.some((block) => block.kind === "text" && block.text === text),
  );
  expect(matching).toHaveLength(1);
  expect(matching[0]?.runId).toBeTruthy();
});

test("Slack keeps an explicit same-channel thread selected while its own receipt is delayed", async ({
  page,
}) => {
  const botId = await setup(page);
  const older = await rpc<{ messageId: string }>(page, "threads/send", {
    botId,
    text: "Older explicit thread selection",
    conversationMode: "thread",
    clientNonce: `ui-selection-older-${Date.now()}`,
  });
  await rpc(page, "threads/stop", { botId, rootMessageId: older.messageId });
  await page.reload();
  await expect(page.getByTestId(`slack-thread-${older.messageId}`)).toBeVisible();

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayedRootId: string | undefined;
  await page.route("**/rpc/threads/send", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    const payload = JSON.parse(body.toString()) as {
      json?: { messageId?: string; rootMessageId?: string };
    };
    delayedRootId = payload.json?.rootMessageId ?? payload.json?.messageId;
    await gate;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body,
    });
  });

  const textarea = page.getByTestId("composer-bar").locator("textarea");
  await textarea.fill("Delayed own receipt");
  await textarea.press("Enter");
  await expect.poll(() => delayedRootId).toBeTruthy();
  await page.getByTestId(`slack-thread-${older.messageId}`).click();
  const panel = page.getByTestId("slack-thread-panel");
  await expect(panel).toContainText("Older explicit thread selection");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
    .toBe("slack-thread-back");
  const selectedUrl = page.url();
  release();
  await expect(panel).toContainText("Older explicit thread selection");
  await expect(panel.locator(`[data-message-id="${delayedRootId}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(selectedUrl);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
    .toBe("slack-thread-back");
});

test("Slack reconciles an accepted send after readback failure without duplicating the root", async ({
  page,
}) => {
  const botId = await setup(page);
  let failReadback = true;
  const sendPayloads: Array<Record<string, unknown>> = [];
  const artifactPayloads: Array<Record<string, unknown>> = [];
  await page.route("**/rpc/threads/get", async (route) => {
    if (failReadback) {
      failReadback = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            defined: false,
            code: "TIMEOUT",
            status: 503,
            message: "History refresh unavailable",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/rpc/threads/send", async (route) => {
    const payload = route.request().postDataJSON() as { json?: Record<string, unknown> };
    sendPayloads.push(payload.json ?? {});
    await route.continue();
  });
  await page.route("**/rpc/artifacts/create", async (route) => {
    const payload = route.request().postDataJSON() as { json?: Record<string, unknown> };
    artifactPayloads.push(payload.json ?? {});
    await route.continue();
  });
  const text = "Accepted before history refresh failed";
  const textarea = page.getByTestId("composer-bar").locator("textarea");
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach file", exact: true }).click();
  await (await fileChooser).setFiles({
    name: "readback-attachment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("accepted attachment"),
  });
  await expect(page.getByText("readback-attachment.txt", { exact: true })).toBeVisible();
  await textarea.fill(text);
  await textarea.press("Enter");
  await expect(page.getByTestId("composer-error")).toContainText("Message sent");
  await expect(textarea).toHaveValue(text);
  await expect.poll(() => sendPayloads.length).toBe(1);
  await textarea.press("Enter");
  await expect(page.getByTestId("slack-thread-panel")).toBeVisible();
  await expect.poll(() => sendPayloads.length).toBe(2);
  expect(sendPayloads[1]?.clientNonce).toBe(sendPayloads[0]?.clientNonce);
  expect(artifactPayloads).toHaveLength(1);
  expect(sendPayloads[1]?.artifactIds).toEqual(sendPayloads[0]?.artifactIds);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId, includeRoots: true });
  const matching = (snapshot.rootMessages ?? []).filter((message) =>
    message.blocks.some((block) => block.text === text),
  );
  expect(matching).toHaveLength(1);
});

test("Slack Back and Escape close a thread without undoing a channel navigation", async ({
  page,
}) => {
  const botId = await setup(page);
  const secondBot = await rpc<{ id: string }>(page, "bots/create", {
    name: "History Sage",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const secondBotId = secondBot.id;
  await page.goto(`/app/${botId}`);
  const root = await rpc<{ messageId: string }>(page, "threads/send", {
    botId,
    text: "History-safe root",
    conversationMode: "thread",
    clientNonce: `ui-history-${Date.now()}`,
  });
  await rpc(page, "threads/stop", { botId, rootMessageId: root.messageId });
  await page.reload();
  await page.getByTestId(`slack-thread-${root.messageId}`).click();
  await expect(page.getByTestId("slack-thread-panel")).toBeVisible();
  await page.getByTestId(`slack-dm-${secondBotId}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${secondBotId}$`));
  await expect(page.getByTestId("slack-thread-panel")).toHaveCount(0);

  await page.goto(`/app/${botId}`);
  await page.getByTestId(`slack-thread-${root.messageId}`).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slack-thread-panel")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));

  await page.getByTestId(`slack-thread-${root.messageId}`).click();
  await page.goBack();
  await expect(page.getByTestId("slack-thread-panel")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
});

test("Slack never offers durable reply actions on transient subagent rows", async ({
  page,
}, testInfo) => {
  const botId = await setup(page);
  const snapshot = await rpc<Snapshot>(page, "threads/get", { botId });
  const hydrateRpc = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;
  await page.route(hydrateRpc, async (route) => {
    const response = await route.fetch();
    const body = JSON.parse(await response.text()) as { json?: Snapshot & { thread?: Snapshot } };
    const thread = body.json?.thread ?? body.json;
    if (thread?.messages) {
      const transient = {
        id: "subagent:compatibility-probe",
        threadId: snapshot.threadId,
        seq: 999999,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Transient subagent compatibility probe" }],
        createdAt: new Date().toISOString(),
      };
      thread.messages.push(transient);
      thread.rootMessages = [...(thread.rootMessages ?? []), transient];
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
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
    await page.getByRole("button", { name: "Back to direct message", exact: true }).tap();
    await page.getByRole("button", { name: "Open Slack navigation", exact: true }).tap();
    await page.getByTestId("slack-view-toggle").tap();
    await expect(page.getByTestId("transcript")).toContainText("Mobile branch compatibility reply");
    await captureScreenshot(page, testInfo, "classic-mobile-same-branch");
  });
});
