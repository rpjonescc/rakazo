// Production bundle smoke: static files only, no API, auth, provider or computer.
// Run after `pnpm build`; all service responses below are explicit test fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@lingui/conf";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
assert.ok(fs.existsSync(path.join(dist, "index.html")), "Build production web first");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-thread-catalog-"));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/rpc") || url.pathname.startsWith("/api")) {
    res.writeHead(503);
    res.end("No backend in this test");
    return;
  }
  const file = path.resolve(dist, url.pathname.slice(1));
  const target =
    file.startsWith(`${dist}/`) && fs.existsSync(file) && fs.statSync(file).isFile()
      ? file
      : path.join(dist, "index.html");
  res.setHeader(
    "content-type",
    { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2" }[
      path.extname(target)
    ] ?? "application/octet-stream",
  );
  res.end(fs.readFileSync(target));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const timestamp = "2026-01-01T00:00:00.000Z";
const bot = {
  id: "fixture-bot",
  spaceId: "fixture-space",
  name: "Fixture agent",
  title: "",
  description: "",
  instructions: "",
  color: "blue",
  status: "idle",
  notifyOnFinish: false,
  computerMode: "none",
  preview: "",
  threadId: "fixture-thread",
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  updatedAt: timestamp,
  createdAt: timestamp,
};
const me = {
  userId: "fixture-user",
  name: "Catalog fixture",
  email: "fixture@example.test",
  spaceId: bot.spaceId,
  needsModel: false,
  defaultProvider: "fixture",
  defaultModel: "fixture",
  computerHost: "docker",
  canChooseHostComputer: false,
  sandboxProvider: "fake",
  avatarStyle: "robot",
  isDeploymentOwner: false,
};
const rootMessage = {
  id: "fixture-root",
  threadId: bot.threadId,
  seq: 1,
  role: "user",
  botId: null,
  blocks: [{ kind: "text", text: "Fixture conversation" }],
  createdAt: timestamp,
  replyCount: 2,
};
const summary = {
  rootMessageId: rootMessage.id,
  participantBotIds: [bot.id],
  replyCount: 2,
  state: "failed",
  runs: [
    { id: "fixture-run", botId: bot.id, taskId: "fixture-task", status: "failed", error: null },
  ],
};
const results = [];
try {
  for (const locale of getConfig({ cwd: root }).locales) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: "dark",
      });
      const errors = [];
      const unexpected = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let populated = false;
      const snapshot = () => ({
        threadId: bot.threadId,
        botId: bot.id,
        messages: populated ? [rootMessage] : [],
        rootMessages: populated ? [rootMessage] : [],
        rootSummaries: populated ? [summary] : [],
        cursor: 1,
        olderCursor: null,
        rootOlderCursor: null,
        run: null,
        computer: null,
      });
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          unexpected.push(url.origin);
          await route.abort();
          return;
        }
        if (url.pathname.startsWith("/api/auth/")) {
          await route.fulfill({
            json: {
              user: { id: me.userId, name: me.name, email: me.email, emailVerified: true },
              session: {
                id: "fixture-session",
                userId: me.userId,
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            },
          });
          return;
        }
        if (url.pathname.startsWith("/rpc/")) {
          const method = url.pathname.slice(5);
          const thread = snapshot();
          const values = {
            bootstrap: {
              me,
              bots: [bot],
              groups: [],
              botSections: [],
              archivedBots: [],
              archivedGroups: [],
              thread,
              routines: [],
              spaces: [],
            },
            "threads/get": thread,
            "threads/replies": {
              threadId: bot.threadId,
              rootMessage,
              rootSummary: summary,
              recipientBotIds: [bot.id],
              messages: [],
              replyCount: 2,
              olderCursor: null,
            },
            "threads/markRead": { ok: true },
            "computer/updates": [],
            "messaging/status": {},
            "memory/providerConfig": {},
            "agentSkills/list": [],
            "voice/status": {},
            "routines/list": [],
            "connections/list": [],
            "connections/catalog": [],
            "skills/list": [],
          };
          if (method === "threads/subscribe") {
            await route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              body: ": fixture\n\n",
            });
            return;
          }
          if (!(method in values)) {
            unexpected.push(method);
            await route.abort();
            return;
          }
          await route.fulfill({ json: { json: values[method] } });
          return;
        }
        await route.continue();
      });
      await page.addInitScript((selected) => {
        localStorage.setItem("rakazo.presentation", "slack");
        localStorage.setItem("rakazo.uiLocale", selected);
      }, locale);
      try {
        await page.goto(`${origin}/app/${bot.id}`);
        const input = page.getByTestId("composer-bar").locator("textarea");
        await expect(input).toBeVisible();
        await expect(input).toHaveValue("");
        await expect(input).toHaveAttribute("placeholder", "Start a conversation");
        assert.equal(await page.locator("html").getAttribute("lang"), locale);
        await page.screenshot({
          path: path.join(output, `${locale}-${width}-composer.png`),
          fullPage: true,
        });
        populated = true;
        await page.reload();
        await page.getByTestId(`slack-thread-${rootMessage.id}`).click();
        const panel = page.getByTestId("slack-thread-panel");
        await expect(panel).toBeVisible();
        await expect(panel.locator("textarea")).toHaveValue("@Fixture agent ");
        await panel.locator("textarea").fill("");
        await expect(panel.locator("textarea")).toHaveAttribute("placeholder", "Reply in thread");
        await expect(panel.getByTestId("thread-recipient-hint")).toHaveText(
          "Continuing with @Fixture agent",
        );
        await expect(panel.getByTestId(`slack-root-failure-${rootMessage.id}`)).toHaveText(
          "Failure: Run failed",
        );
        await expect(panel.getByTestId(`slack-root-retry-${rootMessage.id}`)).toHaveText(
          "Retry in thread",
        );
        await expect(panel.getByTestId(`slack-root-retry-${rootMessage.id}`)).toHaveAttribute(
          "aria-label",
          `Retry root ${rootMessage.id}`,
        );
        const back = page.getByTestId("slack-thread-back");
        await expect(back).toHaveAttribute("aria-label", "Back to direct message");
        await expect(back).toHaveAttribute("title", "Back to direct message");
        await page.screenshot({
          path: path.join(output, `${locale}-${width}-thread.png`),
          fullPage: true,
        });
        await back.click();
        await expect(panel).toHaveCount(0);
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        results.push({
          locale,
          width,
          value: "",
          placeholder: "Start a conversation",
          replyPlaceholder: "Reply in thread",
          errors,
          unexpected,
        });
      } catch (error) {
        await page.screenshot({
          path: path.join(output, `${locale}-${width}-failure.png`),
          fullPage: true,
        });
        throw error;
      } finally {
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, output, results }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
