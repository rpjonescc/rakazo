import "./slack-workspace.css";
import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import {
  ArrowLeft,
  ChevronDown,
  Menu,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { setUiAppearance } from "../../lib/ui-appearance";
import { WindowChrome } from "../WindowChrome";

type Props = {
  active?: Bot;
  activeGroup?: Group;
  activeSnapshot: ThreadSnapshot | null;
  bots: Bot[];
  groups: Group[];
  inGroup: boolean;
  activeName?: string;
  onOpenBot: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onCreateBot: () => void;
  onCreateGroup: () => void;
  onOpenSettings: () => void;
  onOpenComputer: () => void;
  onToggleClassic: () => void;
  onSettings: () => void;
  onSearch: () => void;
  timeline: ReactNode;
  thread: ReactNode;
  threadOpen: boolean;
  replyCount: number;
  repliesLoading: boolean;
  threadFocusMode?: "back" | "composer";
  onCloseThread: () => void;
};

type ThreadHistoryEntry = {
  id: string;
  href: string;
};

export function SlackWorkspace({
  active,
  activeGroup,
  activeSnapshot,
  bots,
  groups,
  inGroup,
  activeName,
  onOpenBot,
  onOpenGroup,
  onCreateBot,
  onCreateGroup,
  onOpenSettings,
  onOpenComputer,
  onToggleClassic,
  onSettings,
  onSearch,
  timeline,
  thread,
  threadOpen,
  replyCount,
  repliesLoading,
  threadFocusMode = "back",
  onCloseThread,
}: Props) {
  const { t } = useLingui();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  const threadCloseRef = useRef(onCloseThread);
  threadCloseRef.current = onCloseThread;
  const threadBackRef = useRef<HTMLButtonElement>(null);
  const focusBeforeThreadRef = useRef<HTMLElement | null>(null);
  const threadHistoryEntryRef = useRef<ThreadHistoryEntry | null>(null);
  const [mobileViewport, setMobileViewport] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1279px)");
    const update = () => setMobileViewport(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!threadOpen) return;
    const activeElement = document.activeElement;
    focusBeforeThreadRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    const entry = {
      id: `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      href: window.location.href,
    };
    window.history.pushState(
      { ...(window.history.state ?? {}), rakazoThread: true, rakazoThreadId: entry.id },
      "",
      entry.href,
    );
    threadHistoryEntryRef.current = entry;
    const onPopState = () => {
      const current = threadHistoryEntryRef.current;
      if (!current || window.history.state?.rakazoThreadId === current.id) return;
      threadHistoryEntryRef.current = null;
      threadCloseRef.current();
      window.requestAnimationFrame(() => focusBeforeThreadRef.current?.focus());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      const current = threadHistoryEntryRef.current;
      threadHistoryEntryRef.current = null;
      if (
        current &&
        window.location.href === current.href &&
        window.history.state?.rakazoThreadId === current.id
      ) {
        window.history.back();
      }
      threadCloseRef.current();
      window.requestAnimationFrame(() => focusBeforeThreadRef.current?.focus());
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
      if (threadHistoryEntryRef.current?.id === entry.id) threadHistoryEntryRef.current = null;
    };
  }, [threadOpen]);

  useEffect(() => {
    if (!threadOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      if (threadFocusMode === "composer" && !repliesLoading) {
        const composer = document.querySelector('[data-testid="slack-thread-panel"] textarea');
        if (composer instanceof HTMLElement) {
          composer.focus();
          return;
        }
      }
      threadBackRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [repliesLoading, threadFocusMode, threadOpen]);

  const closeThread = useCallback(() => {
    const entry = threadHistoryEntryRef.current;
    threadHistoryEntryRef.current = null;
    if (
      entry &&
      window.location.href === entry.href &&
      window.history.state?.rakazoThreadId === entry.id
    ) {
      window.history.back();
    }
    threadCloseRef.current();
    window.requestAnimationFrame(() => focusBeforeThreadRef.current?.focus());
  }, []);

  function toggleTheme() {
    const next = dark ? "light" : "dark";
    setUiAppearance(next);
    setDark(next === "dark");
  }
  return (
    <div
      data-testid="slack-workspace"
      data-chat-view="slack"
      className="relative isolate flex min-w-0 flex-1 overflow-hidden bg-background"
    >
      <aside
        aria-label="Workspace"
        className="hidden w-14 shrink-0 flex-col items-center gap-3 border-e border-sidebar-border bg-sidebar-accent/50 py-4 md:flex"
      >
        <span className="mb-4 text-xl font-semibold">r.</span>
        <button
          type="button"
          aria-label="Create bot"
          onClick={onCreateBot}
          className="grid h-9 w-9 place-items-center rounded-lg hover:bg-accent"
        >
          <Plus size={18} />
        </button>
        <div className="flex-1" />
      </aside>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close Slack navigation"
          onClick={() => setMobileOpen(false)}
          className="absolute inset-0 z-30 bg-overlay/60 md:hidden"
        />
      ) : null}
      <aside
        data-testid="slack-sidebar"
        className={
          "absolute inset-y-0 start-0 z-40 flex w-[min(240px,calc(100%-44px))] shrink-0 -translate-x-full flex-col border-e border-sidebar-border bg-sidebar transition-transform md:static md:translate-x-0 " +
          (mobileOpen ? "translate-x-0" : "")
        }
      >
        <div className="app-drag flex items-center justify-between border-b border-sidebar-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {desktopBridge() ? <WindowChrome /> : null}
            <span className="text-[13px] font-semibold text-foreground">Rakazo</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={dark ? "Use light mode" : "Use dark mode"}
              title={dark ? "Use light mode" : "Use dark mode"}
              onClick={toggleTheme}
              className="app-no-drag grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              {dark ? <Sun size={15} strokeWidth={1.8} /> : <Moon size={15} strokeWidth={1.8} />}
            </button>
            <button
              type="button"
              aria-label="Use classic view"
              title="Use classic view"
              data-testid="slack-view-toggle"
              onClick={onToggleClassic}
              className="app-no-drag rounded-lg px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              Classic
            </button>
          </div>
        </div>
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={onSearch}
            className="w-full flex items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-3 py-2 text-[13px] text-muted-foreground"
          >
            <Search size={14} strokeWidth={1.8} />
            <span>Search</span>
            <span className="ms-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
              K
            </span>
          </button>
        </div>
        <nav className="rk-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div data-testid="slack-channel-list" className="mb-5">
            <div className="mb-1 flex items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
              <span>Channels</span>
              <button
                type="button"
                aria-label="Create channel"
                title="Create channel"
                onClick={() => {
                  setMobileOpen(false);
                  onCreateGroup();
                }}
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <Plus size={14} strokeWidth={1.8} />
              </button>
            </div>
            {groups.length ? (
              groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  data-testid={`slack-channel-${group.id}`}
                  aria-current={activeGroup?.id === group.id ? "page" : undefined}
                  onClick={() => {
                    onOpenGroup(group.id);
                    setMobileOpen(false);
                  }}
                  className={
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-[14px] " +
                    (activeGroup?.id === group.id
                      ? "bg-sidebar-accent font-semibold text-foreground"
                      : "text-foreground/75 hover:bg-sidebar-accent")
                  }
                >
                  <span className="text-[17px] leading-none text-muted-foreground">#</span>
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {group.unread ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
                  ) : null}
                </button>
              ))
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  onCreateGroup();
                }}
                className="w-full rounded-lg px-3 py-2 text-start text-[13px] text-muted-foreground hover:bg-sidebar-accent"
              >
                Create your first channel
              </button>
            )}
          </div>
          <div data-testid="slack-dm-list">
            <div className="mb-1 flex items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
              <span>Direct messages</span>
              <button
                type="button"
                aria-label="Create bot"
                title="Create bot"
                onClick={onCreateBot}
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <Plus size={14} strokeWidth={1.8} />
              </button>
            </div>
            {bots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                data-testid={`slack-dm-${bot.id}`}
                aria-current={active?.id === bot.id ? "page" : undefined}
                onClick={() => {
                  onOpenBot(bot.id);
                  setMobileOpen(false);
                }}
                className={
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start " +
                  (active?.id === bot.id ? "bg-sidebar-accent" : "hover:bg-sidebar-accent")
                }
              >
                <BotAvatar color={bot.color} identity={bot.id} size={27} status={bot.status} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-foreground/85">
                  {bot.name}
                </span>
                {bot.unread ? <span className="h-1.5 w-1.5 rounded-full bg-foreground" /> : null}
              </button>
            ))}
          </div>
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <button
            type="button"
            onClick={onSettings}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <Settings size={15} strokeWidth={1.7} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <main
        inert={threadOpen && mobileViewport ? true : undefined}
        className="flex min-w-0 flex-1 flex-col bg-background"
      >
        <header className="app-drag flex min-h-[63px] items-center justify-between border-b border-sidebar-border px-3 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Open Slack navigation"
              onClick={() => setMobileOpen(true)}
              className="app-no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
            >
              <Menu size={19} strokeWidth={1.7} />
            </button>
            {activeGroup ? (
              <GroupAvatar members={activeSnapshot?.members ?? activeGroup.members} size={28} />
            ) : active ? (
              <BotAvatar
                color={active.color}
                identity={active.id}
                size={28}
                status={active.status}
              />
            ) : null}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-[15.5px] font-semibold text-foreground">
                  {activeGroup ? `# ${activeGroup.name}` : (activeName ?? "Select a bot")}
                </h1>
                <ChevronDown
                  size={14}
                  strokeWidth={1.8}
                  className="shrink-0 text-muted-foreground"
                />
              </div>
              <p className="truncate text-[12px] text-muted-foreground">
                {activeGroup
                  ? `You + ${activeGroup.members.length} ${activeGroup.members.length === 1 ? "agent" : "agents"}`
                  : active
                    ? active.status
                    : "Choose a conversation"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {!inGroup && active ? (
              <button
                type="button"
                aria-label="Agent computer"
                title="Agent computer"
                onClick={onOpenComputer}
                className="app-no-drag grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Monitor size={16} strokeWidth={1.7} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Conversation settings"
              title="Conversation settings"
              onClick={onOpenSettings}
              className="app-no-drag grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings size={16} strokeWidth={1.7} />
            </button>
          </div>
        </header>
        <div data-testid="slack-message-canvas" className="flex min-h-0 flex-1 flex-col">
          {timeline}
        </div>
      </main>
      {threadOpen ? (
        <aside
          data-testid="slack-thread-panel"
          className="absolute inset-y-0 end-0 z-30 flex w-full max-w-[430px] flex-col border-s border-sidebar-border bg-background shadow-xl xl:relative xl:z-auto xl:w-[390px] xl:shadow-none"
        >
          <header className="flex min-h-[63px] items-center gap-2 border-b border-sidebar-border px-3">
            <button
              ref={threadBackRef}
              type="button"
              data-testid="slack-thread-back"
              aria-label={activeGroup ? t`Back to channel` : t`Back to direct message`}
              title={activeGroup ? t`Back to channel` : t`Back to direct message`}
              onClick={closeThread}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft size={18} strokeWidth={1.8} />
            </button>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold">
                Thread{" "}
                <span className="ms-1 text-xs font-normal text-muted-foreground">
                  {activeGroup ? `# ${activeGroup.name}` : activeName}
                </span>
              </h2>
              <p className="text-xs text-muted-foreground">
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </p>
            </div>
          </header>
          {repliesLoading ? (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              Loading replies…
            </div>
          ) : (
            thread
          )}
        </aside>
      ) : null}
    </div>
  );
}
