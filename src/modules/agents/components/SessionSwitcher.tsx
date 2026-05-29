import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { AgentIcon } from "../lib/agentIcon";

export type ClaudeSession = {
  sessionId: string;
  pid: number;
  cwd: string;
  status: string;
  updatedAt: number;
  name: string | null;
  live: boolean;
};

type Props = {
  /** Normalized (forward-slash) cwds of currently live terminal leaves. */
  liveCwds: Set<string>;
  onActivateSession: (session: ClaudeSession) => void;
  onResumeSession: (session: ClaudeSession) => void;
  onOpenDashboard: () => void;
};

export function normalizeCwd(cwd: string): string {
  const slashed = cwd.replace(/\\/g, "/");
  return slashed.length > 1 && slashed.endsWith("/")
    ? slashed.slice(0, -1)
    : slashed;
}

function basename(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function SessionRow({
  session,
  canActivate,
  onActivate,
  onResume,
}: {
  session: ClaudeSession;
  canActivate: boolean;
  onActivate: () => void;
  onResume: () => void;
}) {
  const label = session.name?.trim() || basename(session.cwd);
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
      <AgentIcon
        agent="claude"
        size={16}
        className="shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-sm text-foreground">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              session.live ? "bg-primary" : "bg-muted-foreground/40",
            )}
            title={session.live ? "live" : "idle"}
          />
          <span className="truncate">{label}</span>
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {session.cwd}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={canActivate ? onActivate : onResume}
      >
        {canActivate ? "Activate" : "Resume here"}
      </Button>
    </div>
  );
}

export function SessionSwitcher({
  liveCwds,
  onActivateSession,
  onResumeSession,
  onOpenDashboard,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setLoading(true);
      invoke<ClaudeSession[]>("claude_sessions_list")
        .then(setSessions)
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Claude Code sessions"
        >
          <AgentIcon agent="claude" size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 overflow-hidden p-0 gap-0.5"
      >
        <div className="flex h-10 items-center px-3 pt-0.5">
          <span className="text-[13px] text-foreground">Claude sessions</span>
        </div>
        {loading ? (
          <div className="border-t border-border/60 px-3 py-5 text-center text-xs text-muted-foreground">
            Loading...
          </div>
        ) : sessions.length === 0 ? (
          <div className="border-t border-border/60 px-3 py-5 text-center text-xs text-muted-foreground">
            No Claude sessions
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto border-t border-border/60 p-1">
            {sessions.map((s) => {
              const canActivate = liveCwds.has(normalizeCwd(s.cwd));
              return (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  canActivate={canActivate}
                  onActivate={() => {
                    onActivateSession(s);
                    setOpen(false);
                  }}
                  onResume={() => {
                    onResumeSession(s);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
        )}
        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            onClick={() => {
              onOpenDashboard();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={DashboardSpeed02Icon}
              size={14}
              strokeWidth={1.75}
            />
            Open agent dashboard
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
