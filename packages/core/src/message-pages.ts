interface MessageIdentity {
  id: string;
  seq?: number;
}

interface RootSummaryIdentity {
  rootMessageId: string;
}

export interface ThreadHistory<TMessage extends MessageIdentity> {
  threadId: string;
  messages: readonly TMessage[];
  olderCursor: number | null;
  rootMessages?: readonly TMessage[];
  rootOlderCursor?: number | null;
  rootSummaries?: readonly RootSummaryIdentity[];
}

export function mergeThreadHistory<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, recent: TSnapshot, preserveLoadedHistory = false): TSnapshot {
  if (!previous || previous.threadId !== recent.threadId || !preserveLoadedHistory) return recent;
  return {
    ...recent,
    messages: mergeMessagePages(previous.messages, recent.messages),
    olderCursor: previous.olderCursor,
    ...(previous.rootMessages !== undefined || recent.rootMessages !== undefined
      ? {
          rootMessages: mergeThreadRootMessages(
            previous.rootMessages ?? [],
            recent.rootMessages ?? [],
          ),
          rootOlderCursor:
            previous.rootMessages?.length === 0 || recent.rootMessages?.length === 0
              ? previous.rootOlderCursor
              : hasMessageIdOverlap(previous.rootMessages ?? [], recent.rootMessages ?? [])
                ? previous.rootOlderCursor
                : (recent.rootOlderCursor ??
                  firstMessageSeq(recent.rootMessages ?? []) ??
                  previous.rootOlderCursor),
          rootSummaries:
            previous.rootSummaries !== undefined || recent.rootSummaries !== undefined
              ? mergeThreadRootSummaries(previous.rootSummaries ?? [], recent.rootSummaries ?? [])
              : undefined,
        }
      : {}),
  };
}

export function prependThreadRootHistoryPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, page: ThreadHistory<TMessage>): TSnapshot | null {
  if (!previous || previous.threadId !== page.threadId || previous.rootOlderCursor == null) {
    return previous;
  }
  return {
    ...previous,
    rootMessages: mergeThreadRootMessages(
      page.rootMessages ?? page.messages,
      previous.rootMessages ?? [],
    ),
    rootOlderCursor: page.rootOlderCursor ?? page.olderCursor,
    ...(previous.rootSummaries !== undefined || page.rootSummaries !== undefined
      ? {
          rootSummaries: mergeThreadRootSummaries(
            page.rootSummaries ?? [],
            previous.rootSummaries ?? [],
          ),
        }
      : {}),
  };
}

export function mergeThreadRootMessages<T extends MessageIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of recent) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    if (typeof a.seq !== "number" || typeof b.seq !== "number") return 0;
    return a.seq - b.seq;
  });
}

export function mergeThreadRootSummaries<T extends RootSummaryIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const byId = new Map(previous.map((summary) => [summary.rootMessageId, summary]));
  for (const summary of recent) byId.set(summary.rootMessageId, summary);
  return [...byId.values()];
}

function hasMessageIdOverlap<T extends MessageIdentity>(
  first: readonly T[],
  second: readonly T[],
): boolean {
  const ids = new Set(first.map((message) => message.id));
  return second.some((message) => ids.has(message.id));
}

function firstMessageSeq<T extends MessageIdentity>(messages: readonly T[]): number | null {
  return messages.reduce<number | null>((first, message) => {
    if (typeof message.seq !== "number") return first;
    return Math.min(first ?? message.seq, message.seq);
  }, null);
}

export function prependThreadHistoryPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, page: ThreadHistory<TMessage>): TSnapshot | null {
  if (!previous || previous.threadId !== page.threadId || previous.olderCursor == null) {
    return previous;
  }
  return {
    ...previous,
    messages: mergeMessagesById(page.messages, previous.messages),
    olderCursor: page.olderCursor,
  };
}

export function mergeMessagePages<T extends MessageIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const firstRecentSeq = recent.reduce<number | null>((first, message) => {
    if (!isDurableMessage(message) || typeof message.seq !== "number") return first;
    return Math.min(first ?? message.seq, message.seq);
  }, null);
  const retained =
    firstRecentSeq === null
      ? []
      : previous.filter(
          (message) =>
            isDurableMessage(message) &&
            typeof message.seq === "number" &&
            message.seq < firstRecentSeq,
        );
  return mergeMessagesById(retained, recent);
}

export function mergeMessagesById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function upsertMessageById<T extends { id: string }>(messages: readonly T[], next: T): T[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function isDurableMessage(message: { id: string }): boolean {
  return !message.id.startsWith("progress:") && !message.id.startsWith("subagent:");
}
