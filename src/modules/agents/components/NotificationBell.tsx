import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CheckmarkCircle02Icon,
  Loading03Icon,
  Notification01Icon,
  Notification03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { AgentIcon } from "../lib/agentIcon";
import type { AgentNotification, AgentSession } from "../lib/types";
import { bellBadgeCount } from "../lib/bell";
import { useAgentStore } from "../store/agentStore";

type Props = {
  onActivate: (tabId: number, leafId: number) => void;
};

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function NeedsInputRow({
  session,
  onClick,
}: {
  session: AgentSession;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            <AgentIcon
              agent={session.agent}
              size={14}
              className="mr-1 inline-block align-[-2px] text-muted-foreground"
            />
            {session.agent}
            {session.title ? (
              <span className="text-muted-foreground"> · {session.title}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs font-medium text-primary">
            needs input
          </span>
        </span>
        {session.lastPrompt ? (
          <span className="mt-0.5 truncate text-xs text-muted-foreground">
            {session.lastPrompt}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const NOTIF_LABEL: Record<AgentNotification["kind"], string> = {
  attention: "needs input",
  finished: "finished",
  error: "failed",
};

function NotificationRow({
  n,
  onClick,
}: {
  n: AgentNotification;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {n.kind === "finished" ? (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={15}
            strokeWidth={1.75}
            className="text-muted-foreground"
          />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full",
              n.kind === "error" ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {n.agent}
        {n.title ? <span className="text-muted-foreground"> · {n.title}</span> : null}{" "}
        <span className="text-muted-foreground">{NOTIF_LABEL[n.kind]}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {relativeTime(n.at)}
      </span>
    </button>
  );
}

export function NotificationBell({ onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const [hooksReady, setHooksReady] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const sessions = useAgentStore((s) => s.sessions);
  const notifications = useAgentStore((s) => s.notifications);
  const markAllRead = useAgentStore((s) => s.markAllRead);

  const active = useMemo(() => Object.values(sessions), [sessions]);
  const activeCount = active.length;
  const needsInput = useMemo(
    () => active.filter((s) => s.status === "waiting"),
    [active],
  );
  const badge = bellBadgeCount(active, notifications);

  const refreshHooks = () => {
    invoke<boolean>("agent_claude_hooks_status")
      .then(setHooksReady)
      .catch(() => setHooksReady(null));
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      markAllRead();
      refreshHooks();
    }
  };

  const enableClaudeHooks = async () => {
    setInstalling(true);
    try {
      await invoke("agent_enable_claude_hooks");
      setHooksReady(true);
    } catch {
      setHooksReady(false);
    } finally {
      setInstalling(false);
    }
  };

  const activate = (tabId: number, leafId: number) => {
    onActivate(tabId, leafId);
    setOpen(false);
  };

  const activateNotification = (n: AgentNotification) => {
    activate(n.tabId, n.leafId);
  };

  const empty = needsInput.length === 0 && notifications.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Agent notifications"
        >
          <HugeiconsIcon
            icon={Notification01Icon}
            size={16}
            strokeWidth={1.75}
          />
          {badge > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
              {badge > 9 ? "9+" : badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 overflow-hidden p-0 gap-0.5"
      >
        <div className="flex h-10 items-center px-3 pt-0.5">
          <span className="flex gap-1 text-[13px] text-foreground">
            Notifications
          </span>
          {activeCount > 0 ? (
            <span className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {activeCount} active
            </span>
          ) : null}
        </div>

        {empty ? (
          <div className="border-t border-border/60 px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No agent activity yet.
            <br />
            Run the Terax agent or Claude Code to track it here.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto border-t border-border/60 p-1">
            {needsInput.map((s) => (
              <NeedsInputRow
                key={s.leafId}
                session={s}
                onClick={() => activate(s.tabId, s.leafId)}
              />
            ))}
            {needsInput.length > 0 && notifications.length > 0 ? (
              <div className="mx-2 my-1 h-px bg-border/50" />
            ) : null}
            {notifications.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                onClick={() => activateNotification(n)}
              />
            ))}
          </div>
        )}

        <div className="border-t flex justify-center border-border/60 p-1">
          {hooksReady ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={13}
                strokeWidth={1.75}
                className="text-primary"
              />
              Claude Code alerts enabled
            </div>
          ) : (
            <button
              type="button"
              onClick={enableClaudeHooks}
              disabled={installing}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              <HugeiconsIcon
                icon={installing ? Loading03Icon : Notification03Icon}
                size={14}
                strokeWidth={1.75}
                className={cn(installing && "animate-spin")}
              />
              {installing ? "Enabling..." : "Enable Claude Code alerts"}
            </button>
          )}
          {hooksReady === false && !installing ? (
            <p className="px-2 pt-1 text-[11px] text-destructive">
              Could not update Claude Code config.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
