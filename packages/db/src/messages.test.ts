import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  createThreadMessageInTransaction,
  loadRunHistoryMessages,
  summarizeThreadRoots,
} from "./messages.js";
import { IsolationError } from "./scope.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: {
      create: vi.fn().mockResolvedValue({ id: "message-1" }),
      findFirst: vi.fn(),
    },
    steeringMessage: { findFirst: vi.fn() },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("does not reparent output using an unconsumed steering message", async () => {
    const active = transaction();
    active.run.findUnique
      .mockResolvedValueOnce({ status: "running", startedAt: null })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        sourceMessageId: "original-message",
      });
    active.message.findFirst = vi.fn().mockResolvedValueOnce({
      id: "original-message",
      threadRootMessageId: null,
    });
    active.steeringMessage = {
      findFirst: vi.fn().mockResolvedValue({
        message: { threadRootMessageId: "root-message" },
      }),
    };

    await createThreadMessageInTransaction(active as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "active branch answer" }],
      botId: "bot-1",
      runId: "active-run",
    });

    expect(active.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadRootMessageId: null,
      }),
    });
  });

  it("uses the run's durable conversation root before source-message context", async () => {
    const active = transaction();
    active.run.findUnique
      .mockResolvedValueOnce({ status: "running", startedAt: null })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        sourceMessageId: "stale-source",
        conversationRootMessageId: "root-message",
      });
    active.message.findFirst
      .mockResolvedValueOnce({ id: "stale-source", threadRootMessageId: "root-message" })
      .mockResolvedValueOnce({ id: "root-message", threadRootMessageId: null });

    await createThreadMessageInTransaction(active as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "rooted answer" }],
      botId: "bot-1",
      runId: "active-run",
    });

    expect(active.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadRootMessageId: "root-message",
      }),
    });
  });

  it("rejects an explicit root that disagrees with durable run lineage before writing", async () => {
    const active = transaction();
    active.run.findUnique
      .mockResolvedValueOnce({ status: "running", startedAt: null })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        sourceMessageId: "stale-source",
        conversationRootMessageId: "canonical-root",
      });
    active.message.findFirst
      .mockResolvedValueOnce({ id: "stale-source", threadRootMessageId: "canonical-root" })
      .mockResolvedValueOnce({ id: "canonical-root", threadRootMessageId: null })
      .mockResolvedValueOnce({ id: "unrelated-root", threadRootMessageId: null });

    await expect(
      createThreadMessageInTransaction(active as unknown as Prisma.TransactionClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "forged route" }],
        botId: "bot-1",
        runId: "active-run",
        threadRootMessageId: "unrelated-root",
      }),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(active.thread.update).not.toHaveBeenCalled();
    expect(active.message.create).not.toHaveBeenCalled();
  });

  it("rejects history when a durable root disagrees with an unparented source root", async () => {
    const source = {
      id: "source-root-b",
      seq: 2,
      role: "user",
      runId: "run-b",
      blocks: [],
      threadRootMessageId: null,
      replyToMessageId: null,
    };
    const root = {
      id: "root-a",
      seq: 1,
      role: "user",
      runId: "run-a",
      blocks: [],
      threadRootMessageId: null,
      replyToMessageId: null,
    };
    const messageFindFirst = vi
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(root);
    const prisma = {
      message: {
        findFirst: messageFindFirst,
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    await expect(
      loadRunHistoryMessages(
        prisma,
        {
          id: "run-a",
          threadId: "thread-1",
          sourceMessageId: source.id,
          conversationRootMessageId: root.id,
        },
        50,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("rejects a run from another physical thread before writing", async () => {
    const active = transaction();
    active.run.findUnique
      .mockResolvedValueOnce({ status: "running", startedAt: null })
      .mockResolvedValueOnce({
        threadId: "thread-a",
        sourceMessageId: "source-a",
        conversationRootMessageId: "root-a",
      });

    await expect(
      createThreadMessageInTransaction(active as unknown as Prisma.TransactionClient, {
        threadId: "thread-b",
        role: "bot",
        blocks: [{ kind: "text", text: "foreign route" }],
        botId: "bot-1",
        runId: "active-run",
      }),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(active.thread.update).not.toHaveBeenCalled();
    expect(active.message.create).not.toHaveBeenCalled();
  });

  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });
});

describe("summarizeThreadRoots", () => {
  it("batch-validates run sources instead of resolving one source per run", async () => {
    const runFindMany = vi.fn().mockResolvedValue([
      {
        id: "run-a",
        botId: "bot-a",
        taskId: "task-a",
        status: "running",
        error: null,
        sourceMessageId: "reply-a",
        conversationRootMessageId: "root-a",
      },
      {
        id: "run-b",
        botId: "bot-b",
        taskId: "task-b",
        status: "failed",
        error: "provider unavailable",
        sourceMessageId: "root-b",
        conversationRootMessageId: "root-b",
      },
    ]);
    const messageFindMany = vi.fn().mockResolvedValue([
      { id: "reply-a", threadRootMessageId: "root-a" },
      { id: "root-b", threadRootMessageId: null },
    ]);
    const messageFindFirst = vi.fn();
    const prisma = {
      run: { findMany: runFindMany },
      message: {
        findMany: messageFindMany,
        findFirst: messageFindFirst,
        groupBy: vi.fn().mockResolvedValue([
          { threadRootMessageId: "root-a", botId: "bot-a", _count: { _all: 2 } },
          { threadRootMessageId: "root-b", botId: "bot-b", _count: { _all: 1 } },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(
      summarizeThreadRoots(prisma, "thread-1", [{ id: "root-a" }, { id: "root-b" }]),
    ).resolves.toEqual([
      {
        rootMessageId: "root-a",
        participantBotIds: ["bot-a"],
        replyCount: 2,
        state: "running",
        runs: [
          {
            id: "run-a",
            botId: "bot-a",
            taskId: "task-a",
            status: "running",
            error: null,
          },
        ],
      },
      {
        rootMessageId: "root-b",
        participantBotIds: ["bot-b"],
        replyCount: 1,
        state: "failed",
        runs: [
          {
            id: "run-b",
            botId: "bot-b",
            taskId: "task-b",
            status: "failed",
            error: "provider unavailable",
          },
        ],
      },
    ]);
    expect(runFindMany).toHaveBeenCalledTimes(1);
    expect(messageFindMany).toHaveBeenCalledTimes(1);
    expect(messageFindFirst).not.toHaveBeenCalled();
  });
});
