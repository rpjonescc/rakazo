import { loadRunHistoryMessages, type PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { selectRunHistoryWindow, threadContextForRun } from "../../adapters/src/executor";

const rows = Array.from({ length: 150 }, (_, seq) => ({
  id: `m${seq}`,
  threadId: "thread",
  seq,
  role: "user",
  runId: null,
  threadRootMessageId: seq === 140 || seq === 149 ? "m0" : seq === 141 ? "m1" : null,
  blocks: [{ kind: "text", text: `message ${seq}` }],
}));
type Query = {
  where: { id?: string; threadId?: string; threadRootMessageId?: string | null };
  take?: number;
};
function database() {
  return {
    message: {
      findFirst: async ({ where }: Query) =>
        rows.find((m) => m.id === where.id && m.threadId === where.threadId) ?? null,
      findMany: async ({ where, take }: Query) =>
        rows
          .filter(
            (m) =>
              m.threadId === where.threadId &&
              (where.threadRootMessageId === undefined ||
                m.threadRootMessageId === where.threadRootMessageId),
          )
          .sort((a, b) => b.seq - a.seq)
          .slice(0, take),
    },
  } as unknown as PrismaClient;
}

describe("selected branch execution history", () => {
  it("retains the selected root beyond the final executor window while Classic stays bounded", () => {
    const history = Array.from({ length: 201 }, (_, id) => ({ id }));
    expect(selectRunHistoryWindow(history, "root", 200)).toEqual(history);
    expect(selectRunHistoryWindow(history, null, 200)).toEqual(history.slice(1));
  });
  it("preserves ordinary run summaries and semantic recall", () => {
    const context = { messages: rows, summary: "Classic summary", historyCompactedUpToSeq: 50 };
    expect(threadContextForRun("user", context, false)).toEqual({
      ...context,
      includeSemanticRecall: true,
    });
  });
  it("always includes the old root and only that branch, not unrelated recent messages", async () => {
    const history = await loadRunHistoryMessages(
      database(),
      { id: "run", threadId: "thread", sourceMessageId: "m149" },
      10,
    );
    expect(history.map((m) => m.id)).toEqual(["m149", "m140", "m0"]);
  });
  it("preserves Classic flat history and contiguous compaction coverage for ordinary runs", async () => {
    const history = await loadRunHistoryMessages(
      database(),
      { id: "run", threadId: "thread", sourceMessageId: "m148" },
      10,
    );
    expect(history).toHaveLength(10);
    expect(history.map((m) => m.seq)).toEqual([149, 148, 147, 146, 145, 144, 143, 142, 141, 140]);
  });
  it("rejects a source from a different physical thread", async () => {
    await expect(
      loadRunHistoryMessages(
        database(),
        { id: "run", threadId: "other", sourceMessageId: "m149" },
        10,
      ),
    ).rejects.toThrow();
  });
  it.each(["user", "follow_up", "bot_message"])(
    "does not apply channel-wide summaries or recall to %s branch context",
    (trigger) => {
      const context = threadContextForRun(
        trigger,
        {
          messages: [{ id: "m0" }],
          summary: "unrelated branch summary",
          historyCompactedUpToSeq: 145,
        },
        false,
        true,
      );
      expect(context.messages).toEqual([{ id: "m0" }]);
      expect(context.summary).toBeNull();
      expect(context.historyCompactedUpToSeq).toBeNull();
      expect(context.includeSemanticRecall).toBe(false);
    },
  );
});
