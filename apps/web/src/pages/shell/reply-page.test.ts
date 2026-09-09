import type { ThreadMessage, ThreadReplyPage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { reconcileReplyHead } from "./reply-page";

const message = (seq: number): ThreadMessage => ({
  id: `m${seq}`,
  threadId: "t",
  seq,
  role: "user",
  blocks: [],
  createdAt: "2026-01-01",
  threadRootMessageId: "root",
});
const page = (start: number, end: number, olderCursor: number | null): ThreadReplyPage => ({
  threadId: "t",
  rootMessage: { ...message(0), id: "root", threadRootMessageId: undefined },
  messages: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)),
  olderCursor,
  replyCount: end,
});

describe("reply head reconciliation", () => {
  it.each([null, 1])(
    "fills a disconnected head before preserving loaded history (cursor %s)",
    async (cursor) => {
      const current = page(1, 1, cursor);
      const requests: number[] = [];
      const result = await reconcileReplyHead(current, page(12, 61, 12), async (before) => {
        requests.push(before);
        return page(1, 11, cursor);
      });
      expect(result.messages.map((m) => m.seq)).toEqual(
        Array.from({ length: 61 }, (_, i) => i + 1),
      );
      expect(result.olderCursor).toBe(cursor);
      expect(result.replyCount).toBe(61);
      expect(requests).toEqual([12]);
    },
  );
  it("walks multiple pages until the previously loaded range overlaps", async () => {
    const result = await reconcileReplyHead(page(1, 3, null), page(104, 153, 104), async (before) =>
      page(Math.max(1, before - 50), before - 1, before > 51 ? before - 50 : null),
    );
    expect(result.messages).toHaveLength(153);
    expect(result.olderCursor).toBeNull();
  });
});
