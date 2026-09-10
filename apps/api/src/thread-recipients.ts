import { IsolationError, type Prisma, type PrismaClient } from "@rakazo/db";

/** Only direct user sends establish an audience, never helper output or last reply authors. */
export async function loadThreadRecipientBotIds(
  prisma: PrismaClient | Prisma.TransactionClient,
  threadId: string,
  rootMessageId: string,
): Promise<string[]> {
  const root = await prisma.message.findFirst({
    where: { id: rootMessageId, threadId, threadRootMessageId: null },
    select: { recipientBotIds: true, role: true },
  });
  if (!root) throw new IsolationError();
  if (root.recipientBotIds.length) return root.recipientBotIds;
  if (root.role !== "user") return [];
  // Legacy roots: recover only their original direct recipients, not later helper runs.
  const runs = await prisma.run.findMany({
    where: { threadId, sourceMessageId: rootMessageId, trigger: "user" },
    select: { botId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return [...new Set(runs.map((run) => run.botId))];
}
