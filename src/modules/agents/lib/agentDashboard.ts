import type { ActivityState } from "./activityState";
import type { AgentSession } from "./types";
import { findLeafUuid, type PaneNode } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs";
import type { LeafActivity } from "../store/activityStore";
import type { UsageInfo } from "../store/usageStore";

/** The three triage buckets a card falls into, most-urgent first. */
export type CardPill = "waiting" | "working" | "done";

export type DashboardCard = {
  leafId: number;
  tabId: number;
  uuid: string | null;
  agent: string;
  tabTitle: string;
  pill: CardPill;
  /** Raw activity state, kept for finer labels (blocked vs waiting, done vs idle). */
  activityState: ActivityState;
  currentTool?: string;
  changedFiles: number;
  contextPct?: number;
  model?: string;
  costUsdEst?: number | null;
  startedAt: number;
  lastActivityAt: number;
};

/** Minimal shape the dashboard needs from a tab; lets tests pass tiny fakes. */
type TabLike = Pick<Tab, "id" | "kind"> & {
  title?: string;
  paneTree?: PaneNode;
};

/** A blocked agent or one the host flagged "waiting" is the user's problem to
 *  triage first; a settled (done/idle) agent sinks to the bottom. */
export function pillFor(status: AgentSession["status"], state: ActivityState): CardPill {
  if (state === "blocked" || status === "waiting") return "waiting";
  if (state === "working" || status === "working") return "working";
  return "done";
}

const PILL_RANK: Record<CardPill, number> = {
  waiting: 2,
  working: 1,
  done: 0,
};

/** mm:ss, or h:mm:ss past an hour. Negative/NaN clamps to 0:00. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function leafUuidForSession(
  session: AgentSession,
  tabs: TabLike[],
): string | null {
  const tab = tabs.find((t) => t.id === session.tabId);
  if (!tab || tab.kind !== "terminal" || !tab.paneTree) return null;
  return findLeafUuid(tab.paneTree, session.leafId) ?? null;
}

function tabTitleFor(session: AgentSession, tabs: TabLike[]): string {
  const tab = tabs.find((t) => t.id === session.tabId);
  return tab?.title || session.agent;
}

/**
 * Join the three reactive stores into one card per active agent session.
 * Pure over its inputs so the sort/format/leaf-join invariants are testable
 * without rendering. Sorted waiting > working > done, then lastActivityAt desc.
 */
export function buildCards(
  sessions: Record<number, AgentSession>,
  tabs: TabLike[],
  leaves: Record<string, LeafActivity>,
  usage: Record<string, UsageInfo>,
): DashboardCard[] {
  const cards: DashboardCard[] = [];
  for (const session of Object.values(sessions)) {
    const uuid = leafUuidForSession(session, tabs);
    const activity = uuid ? leaves[uuid] : undefined;
    const usageInfo = uuid ? usage[uuid] : undefined;
    const activityState: ActivityState = activity?.state ?? "idle";
    cards.push({
      leafId: session.leafId,
      tabId: session.tabId,
      uuid,
      agent: session.agent,
      tabTitle: tabTitleFor(session, tabs),
      pill: pillFor(session.status, activityState),
      activityState,
      currentTool: activity?.currentTool,
      changedFiles: activity?.changedFiles.length ?? 0,
      contextPct: usageInfo?.contextPct,
      model: usageInfo?.model,
      costUsdEst: usageInfo?.costUsdEst,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    });
  }
  return sortCards(cards);
}

export function sortCards(cards: DashboardCard[]): DashboardCard[] {
  return [...cards].sort((a, b) => {
    const rank = PILL_RANK[b.pill] - PILL_RANK[a.pill];
    if (rank !== 0) return rank;
    return b.lastActivityAt - a.lastActivityAt;
  });
}
