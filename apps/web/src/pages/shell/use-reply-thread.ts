import type { ThreadMessage, ThreadReplyPage } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

type Target = { botId?: string; groupId?: string };

import { mergeReplyPage, reconcileReplyHead } from "./reply-page";

export function useReplyThread(target: Target, cursor: number) {
  const key = target.groupId ? `group:${target.groupId}` : `bot:${target.botId ?? ""}`;
  const [root, setRoot] = useState<ThreadMessage | null>(null);
  const [page, setPage] = useState<ThreadReplyPage | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef({ key, rootId: "", generation: 0 });
  const request = useRef(0);
  const applied = useRef(0);
  const close = useCallback(() => {
    selection.current = { key, rootId: "", generation: selection.current.generation + 1 };
    setRoot(null);
    setPage(null);
    setError(null);
    setLoading(false);
    setLoadingOlder(false);
  }, [key]);
  useEffect(close, [close]);

  const load = useCallback(
    async (rootId: string, before?: number) => {
      const selected = selection.current;
      if (selected.key !== key || !selected.rootId) return null;
      const id = ++request.current;
      try {
        const fetchPage = (before?: number) =>
          rpc.threads.replies({
            ...(key.startsWith("group:") ? { groupId: key.slice(6) } : { botId: key.slice(4) }),
            rootMessageId: rootId,
            before,
            includePeerRuns: true,
          });
        const head = await fetchPage(before);
        const next =
          before == null ? await reconcileReplyHead(pageRef.current, head, fetchPage) : head;
        // A refreshed head supersedes an older head, not an explicitly requested
        // history page. Both can safely merge while this selection remains active.
        if (selection.current !== selected || (before == null && id < applied.current)) return null;
        if (before == null) {
          applied.current = id;
          setRoot(next.rootMessage);
        }
        setPage((current) =>
          mergeReplyPage(
            current,
            before != null && current
              ? {
                  ...next,
                  rootMessage: current.rootMessage,
                  replyCount: Math.max(current.replyCount, next.replyCount),
                }
              : next,
          ),
        );
        setError(null);
        return next;
      } catch (cause) {
        if (selection.current === selected) {
          setError(cause instanceof Error ? cause.message : "Could not load replies");
        }
        return null;
      }
    },
    [key],
  );

  const open = useCallback(
    async (message: ThreadMessage) => {
      const rootId = message.threadRootMessageId ?? message.id;
      const selected = { key, rootId, generation: selection.current.generation + 1 };
      selection.current = selected;
      setRoot(message);
      setPage(null);
      setError(null);
      setLoading(true);
      try {
        await load(rootId);
      } finally {
        if (selection.current === selected) setLoading(false);
      }
    },
    [key, load],
  );

  const loadOlder = useCallback(async () => {
    if (page?.olderCursor == null || loadingOlder) return;
    const selected = selection.current;
    setLoadingOlder(true);
    try {
      await load(page.rootMessage.id, page.olderCursor);
    } finally {
      if (selection.current === selected) setLoadingOlder(false);
    }
  }, [load, loadingOlder, page]);

  // The existing subscription is authoritative; no second subscription or polling loop.
  useEffect(() => {
    if (!root) return;
    const timer = setTimeout(() => void load(root.threadRootMessageId ?? root.id), 100);
    return () => clearTimeout(timer);
  }, [cursor, load, root?.id]);

  return { root, page, loading, loadingOlder, error, open, close, load, loadOlder };
}
