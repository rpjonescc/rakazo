import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { createThreadMessageInTransaction } from "./messages.js";

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
    active.message.findFirst = vi
      .fn()
      .mockResolvedValueOnce({ threadRootMessageId: null })
      .mockResolvedValueOnce({ threadRootMessageId: "root-message" });
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
