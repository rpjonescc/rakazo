import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

type Group = { id: string; name: string; members: Array<{ botId: string }> };
type Snapshot = {
  messages: Array<{ role: string; botId?: string; blocks: Array<{ text?: string }> }>;
};

test("creator and one agent can create a channel and use it in Classic", async ({
  page,
}, testInfo) => {
  await signup(page, `creator-${Date.now()}@rakazo.test`, "password12", "Channel owner");
  await completeOnboarding(page);
  const myloId = activeBotId(page);
  await rpc(page, "bots/update", { botId: myloId, name: "Mylo" });
  await page.reload();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("slack-workspace")).toHaveCount(0);
  await page.getByTestId("presentation-mode-toggle").click();
  await page.getByRole("button", { name: "Create channel", exact: true }).click();
  const panel = page.getByTestId("side-panel");
  await panel.locator("label:has-text('Name') input").fill("Day");
  const create = panel.getByRole("button", { name: "Create group", exact: true });
  await expect(create).toBeDisabled();
  await panel.getByRole("button", { name: "Mylo", exact: true }).click();
  await expect(create).toBeEnabled();
  await expect(panel).toContainText("You (included)");
  await expect(panel).toContainText("Agents (pick 1–6)");
  await captureScreenshot(page, testInfo, "creator-plus-mylo-enabled");
  const request = page.waitForRequest((r) => r.url().includes("/rpc/groups/create"));
  await create.click();
  expect((await request).postDataJSON()).toEqual({ json: { name: "Day", botIds: [myloId] } });
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupId = new URL(page.url()).pathname.split("/").at(-1)!;
  const readback = async () =>
    (await rpc<Group[]>(page, "groups/list", {})).find((g) => g.id === groupId);
  expect(await readback()).toMatchObject({
    id: groupId,
    name: "Day",
    members: [{ botId: myloId }],
  });
  await page.reload();
  await expect(page.getByTestId(`slack-channel-${groupId}`)).toBeVisible();
  await expect(page.getByTestId("slack-workspace")).toContainText("You + 1 agent");
  await captureScreenshot(page, testInfo, "creator-channel-readback");
  await rpc(page, "threads/send", { groupId, text: "Hello single agent" });
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<Snapshot>(page, "threads/get", { groupId });
        return snapshot.messages.filter((m) => m.role === "bot").map((m) => m.botId);
      },
      { timeout: 30000 },
    )
    .toContain(myloId);
  await page.reload();
  await page.getByTestId("slack-view-toggle").click();
  await expect(page.getByTestId("transcript")).toContainText("Hello single agent");
  await page.reload();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("slack-workspace")).toHaveCount(0);
  await expect(page.getByTestId("transcript")).toContainText("Hello single agent");
  await captureScreenshot(page, testInfo, "creator-channel-classic");
  await page.getByTestId("bot-settings-trigger").click();
  await expect(panel).toContainText("You (included)");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  expect((await readback())?.members).toHaveLength(1);

  const secondId = await createNamedBot(page, "Sage");
  await openNewGroup(page);
  await panel.locator("label:has-text('Name') input").fill("Team");
  await panel.getByRole("button", { name: "Mylo", exact: true }).click();
  await panel.getByRole("button", { name: "Sage", exact: true }).click();
  await panel.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const teamId = new URL(page.url()).pathname.split("/").at(-1)!;
  await rpc(page, "threads/send", {
    groupId: teamId,
    text: "Hello team",
    mentions: [myloId, secondId],
  });
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<Snapshot>(page, "threads/get", { groupId: teamId });
        return [
          ...new Set(snapshot.messages.filter((m) => m.role === "bot").map((m) => m.botId)),
        ].sort();
      },
      { timeout: 30000 },
    )
    .toEqual([myloId, secondId].sort());
  await page.reload();
  await expect(page.getByTestId("transcript")).toContainText("Hello team");
  await captureScreenshot(page, testInfo, "classic-two-agent-channel");
  await rpc(page, "groups/update", { groupId: teamId, botIds: [myloId] });
  expect(
    (await rpc<Group[]>(page, "groups/list", {})).find((g) => g.id === teamId)?.members,
  ).toEqual([expect.objectContaining({ botId: myloId })]);

  const before = (await rpc<Group[]>(page, "groups/list", {})).map((g) => g.id).sort();
  for (const botIds of [
    [],
    [myloId, myloId],
    ["missing-agent"],
    Array.from({ length: 7 }, (_, i) => `bot-${i}`),
  ]) {
    const response = await page.request.post("/rpc/groups/create", {
      data: { json: { name: "Invalid", botIds } },
    });
    expect(response.ok()).toBe(false);
  }
  expect((await rpc<Group[]>(page, "groups/list", {})).map((g) => g.id).sort()).toEqual(before);
});
