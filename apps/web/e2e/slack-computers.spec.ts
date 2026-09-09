import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type Status = {
  botId: string;
  mode: "team" | "dedicated";
  kind: string;
  state: string;
  controlBotId: string | null;
};
const status = (page: Page, botId: string) => rpc<Status>(page, "computer/status", { botId });

async function createInSlack(page: Page, name: string, mode: "team" | "dedicated") {
  await page.getByRole("button", { name: "Create bot", exact: true }).last().click();
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill(name);
  await form.getByTestId(mode === "team" ? "create-bot-team" : "create-bot-private").click();
  const request = page.waitForRequest((r) => r.url().includes("/rpc/bots/create"));
  const response = page.waitForResponse((r) => r.url().includes("/rpc/bots/create") && r.ok());
  await form.getByRole("button", { name: "Create", exact: true }).click();
  expect((await request).postDataJSON().json).toMatchObject({ name, computerMode: mode });
  const bot = (await (await response).json()).json;
  await page.waitForURL(`**/app/${bot.id}`);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect.poll(async () => (await status(page, bot.id)).mode).toBe(mode);
  await rpc(page, "threads/stop", { botId: bot.id });
  return bot.id as string;
}

async function openAssignedComputer(page: Page, botId: string, mode: "team" | "dedicated") {
  await page.getByTestId(`slack-dm-${botId}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  const takeover = page.waitForRequest((r) => r.url().includes("/rpc/computer/takeover"));
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  expect((await takeover).postDataJSON()).toEqual({ json: { botId } });
  await expect(page.getByTestId("computer-chrome")).toBeVisible();
  await expect
    .poll(() =>
      page.getByTestId("computer-chrome").evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.left + 120, box.top + box.height / 2),
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() => status(page, botId))
    .toMatchObject({ botId, mode, kind: "fake", state: "running", controlBotId: botId });
}

async function release(page: Page) {
  await page
    .getByTestId("computer-chrome")
    .getByRole("button", { name: "Release", exact: true })
    .click();
  await expect(page.getByTestId("computer-chrome")).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
}

async function changeMode(page: Page, botId: string, mode: "team" | "dedicated") {
  await page.getByRole("button", { name: "Conversation settings", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("bot-settings-advanced").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await settings
    .getByRole("button", { name: mode === "team" ? "Team" : "Private", exact: true })
    .click();
  const request = page.waitForRequest((r) => r.url().includes("/rpc/bots/setComputer"));
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ json: { botId, mode } });
  await expect.poll(async () => (await status(page, botId)).mode).toBe(mode);
  await page.reload();
  expect(
    (await rpc<Array<{ id: string; computerMode: string }>>(page, "bots/list", {})).find(
      (bot) => bot.id === botId,
    )?.computerMode,
  ).toBe(mode);
}

test("Slack preserves private and Team computer assignment through creation, channels, settings and Classic", async ({
  page,
  browser,
}, testInfo) => {
  await signup(
    page,
    `slack-computers-${Date.now()}@rakazo.test`,
    "password12",
    "Computer compatibility",
  );
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  await page.getByTestId("presentation-mode-toggle").click();
  const teamId = await createInSlack(page, "Team Agent", "team");
  const privateId = await createInSlack(page, "Private Agent", "dedicated");
  await page.reload();
  expect(await status(page, teamId)).toMatchObject({ botId: teamId, mode: "team" });
  expect(await status(page, privateId)).toMatchObject({ botId: privateId, mode: "dedicated" });
  await openAssignedComputer(page, privateId, "dedicated");
  expect((await status(page, teamId)).controlBotId).not.toBe(privateId);
  expect((await status(page, chiefId)).controlBotId).not.toBe(privateId);
  await captureScreenshot(page, testInfo, "slack-private-computer-assigned");
  await release(page);
  await openAssignedComputer(page, teamId, "team");
  expect((await status(page, chiefId)).controlBotId).toBe(teamId);
  expect((await status(page, privateId)).controlBotId).not.toBe(teamId);
  await captureScreenshot(page, testInfo, "slack-team-computer-shared");
  await release(page);
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Mixed computers",
    botIds: [privateId, teamId],
  });
  await page.reload();
  await page.getByTestId(`slack-channel-${group.id}`).click();
  await expect(page.getByRole("button", { name: "Agent computer", exact: true })).toHaveCount(0);
  expect((await status(page, privateId)).mode).toBe("dedicated");
  expect((await status(page, teamId)).mode).toBe("team");
  await captureScreenshot(page, testInfo, "slack-channel-retains-individual-computers");
  await page.getByTestId(`slack-dm-${privateId}`).click();
  await changeMode(page, privateId, "team");
  await openAssignedComputer(page, privateId, "team");
  expect((await status(page, chiefId)).controlBotId).toBe(privateId);
  await release(page);
  await changeMode(page, privateId, "dedicated");
  await openAssignedComputer(page, privateId, "dedicated");
  expect((await status(page, chiefId)).controlBotId).not.toBe(privateId);
  await release(page);
  await page.getByTestId("slack-view-toggle").click();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await page.getByTitle("Agent computer").click();
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await expect
    .poll(() => status(page, privateId))
    .toMatchObject({ botId: privateId, mode: "dedicated", controlBotId: privateId });
  await captureScreenshot(page, testInfo, "classic-same-private-computer");
  await release(page);

  const outsider = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const other = await outsider.newPage();
  try {
    await signup(
      other,
      `computer-outsider-${Date.now()}@rakazo.test`,
      "password12",
      "Other computer owner",
    );
    await completeOnboarding(other);
    for (const botId of [privateId, teamId]) {
      for (const procedure of [
        "computer/status",
        "computer/screenUrl",
        "computer/boot",
        "computer/takeover",
        "computer/readFile",
        "bots/setComputer",
      ]) {
        const response = await other.request.post(`/rpc/${procedure}`, {
          data: { json: { botId, path: "notes/result.txt", mode: "team" } },
        });
        expect(response.ok(), `${procedure} must deny foreign ${botId}`).toBe(false);
      }
    }
    expect((await status(page, privateId)).mode).toBe("dedicated");
    expect((await status(page, teamId)).mode).toBe("team");
    expect((await status(page, privateId)).controlBotId).toBeNull();
  } finally {
    await outsider.close();
  }
});
