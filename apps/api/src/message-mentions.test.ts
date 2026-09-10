import { describe, expect, it } from "vitest";
import { withMessageMentions } from "./message-mentions.js";

const sage = { id: "sage-id", name: "Sage", color: "#123456" };
const writer = { id: "writer-id", name: "Mylo Writer" };
const decorate = (
  text: string,
  bots: Array<{ id: string; name: string; color?: string }> = [sage],
  everyone = false,
) => withMessageMentions([{ kind: "text", text }], bots, everyone)[0];

describe("server-authored mention display snapshots", () => {
  it("snapshots only display fields, never the full authorized bot record", () => {
    const bot = {
      ...sage,
      instructions: "private instructions",
      userId: "owner",
      credential: "fixture-only",
    };
    const result = decorate("@Sage hi", [bot]);
    expect(result).toEqual({
      kind: "text",
      text: "@Sage hi",
      mentions: [
        { kind: "bot", id: sage.id, name: sage.name, color: sage.color, start: 0, end: 5 },
      ],
    });
  });

  it("preserves exact text and identity for the leading recipient list", () => {
    expect(decorate(" @sAgE @Mylo Writer hello", [sage, writer])).toEqual({
      kind: "text",
      text: " @sAgE @Mylo Writer hello",
      mentions: [
        { kind: "bot", ...sage, start: 1, end: 6 },
        { kind: "bot", ...writer, start: 7, end: 19 },
      ],
    });
  });
  it.each([
    "person@Sage.example",
    "@Sage.example hello",
    "Discuss @Sage please",
    "`@Sage`",
    "```\n@Sage code\n```",
    "    ```\n@Sage\n```",
    "<img src=x onerror=alert(1)> @Sage",
    "@Sage<script>alert(1)</script>",
    "@Sageish hello",
    "\\@Sage hello",
    "@Unknown hi",
  ])("keeps prose, email, code and unknown identity literal: %s", (text) => {
    expect(decorate(text)).toEqual({ kind: "text", text, mentions: [] });
  });
  it("does not decorate a mention in later prose or a code block", () => {
    expect(decorate("@Sage hello\n```\n@Sage\n```")).toMatchObject({
      mentions: [{ id: sage.id, start: 0, end: 5 }],
    });
  });
  it("fails closed for ambiguous names and names not in resolved targets", () => {
    expect(decorate("@Sage hi", [sage, { ...sage, id: "different" }])).toMatchObject({
      mentions: [],
    });
    expect(decorate("@Sage hi", [writer])).toMatchObject({ mentions: [] });
  });
  it("represents everyone only when the server confirms the complete audience", () => {
    expect(decorate("@everyone hi")).toMatchObject({ mentions: [] });
    expect(decorate("@everyone hi", [sage], true)).toMatchObject({
      mentions: [{ kind: "everyone", name: "everyone", start: 0, end: 9 }],
    });
  });
});
