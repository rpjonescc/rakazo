import type { ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { projectMessages } from "@rakazo/core";
import { appendEventInTransaction, type Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reduceThreadSnapshot } from "../../../apps/web/src/lib/thread-events";

describe("branch streaming", () => {
  it.each(["thread.progress", "agent.tool.called", "thread.subagent"] as const)(
    "persists authoritative run ancestry for %s, then projects live and reconnect identically",
    async (type) => {
      const events: ProductEvent[] = [];
      for (const [i, root] of ["root-a", "root-b", null].entries()) {
        const tx = {
          thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: i + 1 }) },
          run: {
            findUnique: vi.fn().mockResolvedValue({
              status: "running",
              threadId: "thread",
              sourceMessageId: `source-${i}`,
            }),
          },
          message: {
            findFirst: vi.fn(async (args: { where?: { id?: string } }) => {
              const id = args.where?.id ?? `source-${i}`;
              return {
                id,
                threadRootMessageId: id.startsWith("root-") ? null : root,
              };
            }),
          },
          event: {
            create: vi.fn(async ({ data }) => ({
              ...data,
              id: `event-${i}`,
              createdAt: "2026-01-01",
            })),
          },
        };
        const event = await appendEventInTransaction(tx as unknown as Prisma.TransactionClient, {
          spaceId: "space",
          threadId: "thread",
          botId: `bot-${i}`,
          runId: `run-${i}`,
          type,
          payload: {
            text: "Working",
            name: "shell",
            agentId: `agent-${i}`,
            task: "check",
            status: "running",
            threadRootMessageId: "untrusted-root",
          },
        });
        expect(event.payload).toMatchObject({ threadRootMessageId: root });
        events.push(event as unknown as ProductEvent);
      }
      const initial = {
        threadId: "thread",
        botId: "bot-0",
        cursor: 0,
        messages: [],
        run: null,
      } as unknown as ThreadSnapshot;
      const live = events.reduce((state, event) => reduceThreadSnapshot(state, event)!, initial);
      for (const messages of [live.messages, projectMessages(events)]) {
        expect(messages.map((m) => m.threadRootMessageId ?? null)).toEqual([
          "root-a",
          "root-b",
          null,
        ]);
        expect(messages.filter((m) => !m.threadRootMessageId).map((m) => m.runId)).toEqual([
          "run-2",
        ]);
      }
    },
  );
});
