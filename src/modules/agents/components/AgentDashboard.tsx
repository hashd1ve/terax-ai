import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Tab } from "@/modules/tabs";
import {
  ArrowRight01Icon,
  File02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import {
  buildCards,
  formatElapsed,
  type CardPill,
  type DashboardCard,
} from "../lib/agentDashboard";
import { AgentIcon } from "../lib/agentIcon";
import { useActivityStore } from "../store/activityStore";
import { useAgentStore } from "../store/agentStore";
import {
  CONTEXT_WARN_PCT,
  formatContextPct,
  formatCost,
  shortModelName,
  useUsageStore,
} from "../store/usageStore";

type Props = {
  tabs: Tab[];
  /** True only while the dashboard is the foreground tab; gates the 1s clock. */
  active: boolean;
  onActivate: (tabId: number, leafId: number) => void;
};

const PILL_LABEL: Record<CardPill, string> = {
  waiting: "needs input",
  working: "working",
  done: "done",
};

function PillBadge({ card }: { card: DashboardCard }) {
  // Reuse the tab-bar tokens: blocked/waiting -> red, working -> blue spinner,
  // done/idle -> muted dot.
  const label =
    card.pill === "waiting" && card.activityState !== "blocked"
      ? "waiting"
      : PILL_LABEL[card.pill];
  if (card.pill === "working") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-blue-500">
        <HugeiconsIcon
          icon={Loading03Icon}
          size={12}
          strokeWidth={2}
          className="animate-spin"
        />
        {label}
      </span>
    );
  }
  if (card.pill === "waiting") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-red-500">
        <span className="size-1.5 rounded-full bg-red-500" />
        {label}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      {label}
    </span>
  );
}

function Card({
  card,
  now,
  onActivate,
}: {
  card: DashboardCard;
  now: number;
  onActivate: () => void;
}) {
  const pct =
    card.contextPct !== undefined ? formatContextPct(card.contextPct) : null;
  const warn = pct !== null && pct > CONTEXT_WARN_PCT;
  const cost = formatCost(card.costUsdEst ?? null);

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2.5">
        <AgentIcon
          agent={card.agent}
          size={18}
          className="shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {card.agent}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {card.tabTitle}
          </span>
        </div>
        <PillBadge card={card} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {card.currentTool ? (
          <span className="truncate font-mono text-foreground/80">
            {card.currentTool}
          </span>
        ) : null}
        {pct !== null ? (
          <span
            className={cn(
              "tabular-nums",
              warn ? "font-medium text-destructive" : "",
            )}
            title={card.model ? shortModelName(card.model) : undefined}
          >
            ctx {pct}%
          </span>
        ) : null}
        <span className="flex items-center gap-1 tabular-nums">
          <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={1.75} />
          {card.changedFiles}
        </span>
        <span className="tabular-nums">{formatElapsed(now - card.startedAt)}</span>
        {cost ? <span className="tabular-nums">~{cost}</span> : null}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onActivate}
        className="h-7 w-fit gap-1 self-end rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Focus
        <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

export function AgentDashboard({ tabs, active, onActivate }: Props) {
  const sessions = useAgentStore((s) => s.sessions);
  const leaves = useActivityStore((s) => s.leaves);
  const usage = useUsageStore((s) => s.byLeaf);

  // A foreground-only 1s clock so elapsed times advance; no backend polling.
  // Stays off while the tab is hidden so a background dashboard costs nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active]);

  const cards = useMemo(
    () => buildCards(sessions, tabs, leaves, usage),
    [sessions, tabs, leaves, usage],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center px-4">
        <span className="text-sm font-medium text-foreground">Agents</span>
        {cards.length > 0 ? (
          <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {cards.length}
          </span>
        ) : null}
      </div>
      {cards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No active agents
        </div>
      ) : (
        <div className="grid flex-1 content-start gap-2.5 overflow-y-auto px-4 pb-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
          {cards.map((card) => (
            <Card
              key={card.leafId}
              card={card}
              now={now}
              onActivate={() => onActivate(card.tabId, card.leafId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
