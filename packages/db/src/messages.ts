import type { MessageBlock, ThreadRootSummary } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type MessageDb = PrismaClient | Prisma.TransactionClient;

export type ConversationRunContext = {
  threadId: string;
  sourceMessageId?: string | null;
  conversationRootMessageId?: string | null;
};

/**
 * Resolve the root from durable run lineage. The stored root is authoritative;
 * source-message fallback exists for legacy runs only.
 */
export async function resolveConversationRootMessageId(
  prisma: MessageDb,
  run: ConversationRunContext,
): Promise<string | null> {
  const source = run.sourceMessageId
    ? await prisma.message.findFirst({
        where: { id: run.sourceMessageId, threadId: run.threadId },
        select: { id: true, threadRootMessageId: true },
      })
    : null;
  if (run.sourceMessageId && !source) throw new IsolationError();

  const candidateId = run.conversationRootMessageId ?? source?.id ?? run.sourceMessageId;
  if (!candidateId) return null;
  const candidate =
    source?.id === candidateId
      ? source
      : await prisma.message.findFirst({
          where: { id: candidateId, threadId: run.threadId },
          select: { id: true, threadRootMessageId: true },
        });
  if (!candidate) throw new IsolationError();
  const rootId = run.conversationRootMessageId
    ? candidate.id
    : (candidate.threadRootMessageId ?? null);
  if (!rootId) return null;
  const root =
    rootId === candidate.id
      ? candidate
      : await prisma.message.findFirst({
          where: { id: rootId, threadId: run.threadId },
          select: { id: true, threadRootMessageId: true },
        });
  if (!root || root.threadRootMessageId) throw new IsolationError();
  if (run.conversationRootMessageId && source) {
    const sourceRootId = source.threadRootMessageId ?? source.id;
    if (sourceRootId !== root.id) throw new IsolationError();
  }
  return root.id;
}

type RootSummaryInput = { id: string; replyCount?: number | null };

/**
 * Summarize only the requested roots. Reply counts and participants are
 * database aggregates; individual branch rows are never loaded for a root list.
 */
export async function summarizeThreadRoots(
  prisma: MessageDb,
  threadId: string,
  roots: readonly RootSummaryInput[],
): Promise<ThreadRootSummary[]> {
  if (roots.length === 0) return [];
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const [runs, replyGroups] = await Promise.all([
    prisma.run.findMany({
      where: {
        threadId,
        OR: [
          { conversationRootMessageId: { in: rootIds } },
          { sourceMessage: { threadRootMessageId: { in: rootIds } } },
        ],
      },
      select: {
        id: true,
        botId: true,
        taskId: true,
        status: true,
        error: true,
        sourceMessageId: true,
        conversationRootMessageId: true,
      },
    }),
    prisma.message.groupBy({
      by: ["threadRootMessageId", "botId"],
      where: { threadId, threadRootMessageId: { in: rootIds } },
      _count: { _all: true },
    }),
  ]);
  const sourceMessageIds = [
    ...new Set(runs.map((run) => run.sourceMessageId).filter((id): id is string => Boolean(id))),
  ];
  const sourceMessages = sourceMessageIds.length
    ? await prisma.message.findMany({
        where: { threadId, id: { in: sourceMessageIds } },
        select: { id: true, threadRootMessageId: true },
      })
    : [];
  const sourcesById = new Map(sourceMessages.map((message) => [message.id, message]));
  if (sourcesById.size !== sourceMessageIds.length) throw new IsolationError();
  const selectedRootIds = new Set(rootIds);
  const statuses = new Map<string, string[]>();
  const participants = new Map<string, Set<string>>();
  const replyCounts = new Map<string, number>();
  const runsByRoot = new Map<string, ThreadRootSummary["runs"]>();
  for (const rootId of rootIds) {
    statuses.set(rootId, []);
    participants.set(rootId, new Set());
    runsByRoot.set(rootId, []);
  }
  for (const group of replyGroups) {
    if (!group.threadRootMessageId) continue;
    replyCounts.set(
      group.threadRootMessageId,
      (replyCounts.get(group.threadRootMessageId) ?? 0) + group._count._all,
    );
    if (group.botId) participants.get(group.threadRootMessageId)?.add(group.botId);
  }
  for (const run of runs) {
    const source = run.sourceMessageId ? sourcesById.get(run.sourceMessageId) : null;
    if (run.sourceMessageId && !source) throw new IsolationError();
    if (run.conversationRootMessageId && source) {
      const sourceRootId = source.threadRootMessageId ?? source.id;
      if (sourceRootId !== run.conversationRootMessageId) throw new IsolationError();
    }
    if (run.conversationRootMessageId && !selectedRootIds.has(run.conversationRootMessageId)) {
      throw new IsolationError();
    }
    const rootId = run.conversationRootMessageId ?? source?.threadRootMessageId ?? null;
    if (!rootId || !statuses.has(rootId)) continue;
    statuses.get(rootId)!.push(run.status);
    participants.get(rootId)?.add(run.botId);
    runsByRoot.get(rootId)!.push({
      id: run.id,
      botId: run.botId,
      taskId: run.taskId,
      status: run.status as ThreadRootSummary["runs"][number]["status"],
      error: clampRootRunError(run.error),
    });
  }
  return roots.map((root) => ({
    rootMessageId: root.id,
    participantBotIds: [...(participants.get(root.id) ?? new Set())].sort(),
    replyCount: root.replyCount ?? replyCounts.get(root.id) ?? 0,
    state: summarizeRootState(statuses.get(root.id) ?? []),
    runs: runsByRoot.get(root.id) ?? [],
  }));
}

function clampRootRunError(error: string | null): string | null {
  if (!error?.trim()) return null;
  const message = error.trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function summarizeRootState(statuses: readonly string[]): ThreadRootSummary["state"] {
  if (statuses.length === 0) return "silent";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => status === "waiting_input")) return "waiting_input";
  if (statuses.every((status) => status === "waiting_takeover")) return "waiting_takeover";
  if (statuses.every((status) => status === "queued")) return "queued";
  if (
    statuses.every((status) => status === "queued" || status === "leased" || status === "running")
  ) {
    return statuses.some((status) => status === "leased" || status === "running")
      ? "running"
      : "queued";
  }
  return "mixed";
}

/** Group turns use channel inputs and their own outputs, never private thread history. */
export async function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: {
    id: string;
    threadId: string;
    sourceMessageId?: string | null;
    conversationRootMessageId?: string | null;
  },
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
  const durableRootId = await resolveConversationRootMessageId(prisma, run);
  if (durableRootId) {
    const root = await prisma.message.findFirst({
      where: { id: durableRootId, threadId: run.threadId },
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
      ...new Map(
        [...branch, source, root]
          .filter((message): message is NonNullable<typeof message> => Boolean(message))
          .map((message) => [message.id, message]),
      ).values(),
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
  let durableRoot: string | null = null;
  if (input.runId) {
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        threadId: true,
        sourceMessageId: true,
        conversationRootMessageId: true,
      },
    });
    if (run && run.threadId !== input.threadId) throw new IsolationError();
    if (run) durableRoot = await resolveConversationRootMessageId(tx, run);
  }

  if (input.threadRootMessageId) {
    const parent = await tx.message.findFirst({
      where: { id: input.threadRootMessageId, threadId: input.threadId },
      select: { id: true, threadRootMessageId: true },
    });
    if (!parent) throw new IsolationError();
    const explicitRoot = parent.threadRootMessageId ?? parent.id;
    if (input.runId && durableRoot !== explicitRoot) throw new IsolationError();
    return durableRoot ?? explicitRoot;
  }

  return durableRoot;
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  await assertRunCanWriteHistory(tx, input.runId);
  const threadRootMessageId = await resolveThreadRootMessageId(tx, input);
  if (input.replyToMessageId) {
    const parent = await tx.message.findFirst({
      where: { id: input.replyToMessageId, threadId: input.threadId },
      select: { id: true },
    });
    if (!parent) throw new IsolationError();
  }
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
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
