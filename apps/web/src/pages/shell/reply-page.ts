import type { ThreadReplyPage } from "@rakazo/contracts";
/** Keep loaded history when a new authoritative head arrives. */
export function mergeReplyPage(
  current: ThreadReplyPage | null,
  next: ThreadReplyPage,
): ThreadReplyPage {
  if (!current || current.rootMessage.id !== next.rootMessage.id) return next;
  const messages = new Map(current.messages.map((message) => [message.id, message]));
  for (const message of next.messages) messages.set(message.id, message);
  const keepsOlder = Boolean(
    current.messages[0] && next.messages[0] && current.messages[0].seq < next.messages[0].seq,
  );
  return {
    ...next,
    messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
    olderCursor: keepsOlder ? current.olderCursor : next.olderCursor,
  };
}

export async function reconcileReplyHead(
  current: ThreadReplyPage | null,
  next: ThreadReplyPage,
  loadBefore: (before: number) => Promise<ThreadReplyPage>,
): Promise<ThreadReplyPage> {
  if (!current || current.rootMessage.id !== next.rootMessage.id) return next;
  const known = new Set(current.messages.map((message) => message.id));
  let contiguous = next;
  while (
    contiguous.olderCursor != null &&
    current.messages.length > 0 &&
    !contiguous.messages.some((message) => known.has(message.id))
  ) {
    const before = contiguous.olderCursor;
    const older = await loadBefore(before);
    if (older.olderCursor != null && older.olderCursor >= before) {
      throw new Error("Reply history cursor did not advance");
    }
    contiguous = {
      ...mergeReplyPage(contiguous, older),
      rootMessage: next.rootMessage,
      replyCount: next.replyCount,
    };
  }
  return mergeReplyPage(current, contiguous);
}
