import { describe, expect, it } from "vitest";
import { CreateGroupInput, UpdateGroupInput } from "./index.js";

describe("channel description contract", () => {
  it("trims optional context and distinguishes omission from clearing", () => {
    expect(
      CreateGroupInput.parse({
        name: "Planning",
        botIds: ["bot"],
        description: "  Shared purpose  ",
      }),
    ).toMatchObject({ description: "Shared purpose" });
    expect(UpdateGroupInput.parse({ groupId: "group", description: "  " })).toMatchObject({
      description: "",
    });
    expect(UpdateGroupInput.parse({ groupId: "group", name: "Renamed" })).not.toHaveProperty(
      "description",
    );
    expect(CreateGroupInput.parse({ name: "Planning", botIds: ["bot"] })).not.toHaveProperty(
      "description",
    );
    for (const description of [null, 42, {}, "x".repeat(4001)]) {
      expect(
        CreateGroupInput.safeParse({ name: "Planning", botIds: ["bot"], description }).success,
      ).toBe(false);
      expect(UpdateGroupInput.safeParse({ groupId: "group", description }).success).toBe(false);
    }
    expect(
      UpdateGroupInput.safeParse({ groupId: "group", description: "x".repeat(4000) }).success,
    ).toBe(true);
  });
});
