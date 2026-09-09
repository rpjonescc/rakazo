import { describe, expect, it } from "vitest";
import { CreateGroupInput, UpdateGroupInput } from "./index.js";

describe("group agent membership", () => {
  it("accepts one agent alongside the implicit human owner", () => {
    expect(CreateGroupInput.parse({ name: "Day", botIds: ["mylo"] })).toEqual({
      name: "Day",
      botIds: ["mylo"],
    });
    expect(UpdateGroupInput.parse({ groupId: "day", botIds: ["mylo"] }).botIds).toEqual(["mylo"]);
  });
  it("preserves the six-agent maximum and rejects empty or duplicate selections", () => {
    for (const botIds of [[], ["mylo", "mylo"], Array.from({ length: 7 }, (_, i) => `bot-${i}`)]) {
      expect(CreateGroupInput.safeParse({ name: "Day", botIds }).success).toBe(false);
      expect(UpdateGroupInput.safeParse({ groupId: "day", botIds }).success).toBe(false);
    }
    expect(
      CreateGroupInput.safeParse({
        name: "Day",
        botIds: Array.from({ length: 6 }, (_, i) => `bot-${i}`),
      }).success,
    ).toBe(true);
  });
});
