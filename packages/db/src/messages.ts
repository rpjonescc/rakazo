import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** Group turns use channel inputs and their own outputs, never private thread history. */
export async function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string; sourceMessageId?: string | null },
  limit: number,
  channelId?: string,
) {
  const select = {
    id: true,
    seq: true,
    role: true,
    runId: true,
    blocks: true,
    threadRootMessageId: true,
    replyToMessageId: true,
  } as const;
  const source = run.sourceMessageId
    ? await prisma.message.findFirst({
        where: { id: run.sourceMessageId, threadId: run.threadId },
        select,
      })
    : null;
  if (run.sourceMessageId && !source) throw new IsolationError();
  if (source?.threadRootMessageId) {
    const root = await prisma.message.findFirst({
      where: { id: source.threadRootMessageId, threadId: run.threadId },
      select,
    });
    if (!root || root.threadRootMessageId) throw new IsolationError();
    const branch = await prisma.message.findMany({
      where: { threadId: run.threadId, threadRootMessageId: root.id },
      orderBy: { seq: "desc" },
      take: limit,
      select,
    });
    return [
      ...new Map([...branch, source, root].map((message) => [message.id, message])).values(),
    ].sort((a, b) => b.seq - a.seq);
  }
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select,
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  threadRootMessageId?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    createThreadMessageInTransaction(tx, input),
  );
}

async function resolveThreadRootMessageId(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
): Promise<string | null> {
  if (input.threadRootMessageId) {
    const parent = await tx.message.findFirst({
      where: { id: input.threadRootMessageId, threadId: input.threadId },
      select: { id: true, threadRootMessageId: true },
    });
    if (!parent) throw new IsolationError();
    return parent.threadRootMessageId ?? parent.id;
  }

  if (input.runId) {
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { threadId: true, sourceMessageId: true },
    });
    if (run?.threadId === input.threadId && run.sourceMessageId) {
      const source = await tx.message.findFirst({
        where: { id: run.sourceMessageId, threadId: input.threadId },
        select: { threadRootMessageId: true },
      });
      if (source?.threadRootMessageId) return source.threadRootMessageId;
    }
  }

  return null;
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId);
  const threadRootMessageId = await resolveThreadRootMessageId(tx, input);
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      threadRootMessageId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<{ status: string; startedAt: Date | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true },
  });
  if (!run || run.status === "cancelled") {
    throw new RunHistoryWriteError();
  }
  return run;
}
