import { create } from "zustand";

/** Mirror of the Rust `UsageInfo` (camelCase via serde). All fields best-effort:
 *  the Rust side degrades to null when the transcript drifts or is missing. */
export type UsageInfo = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  costUsdEst: number | null;
  title: string | null;
  lastPrompt: string | null;
};

type UsageStoreState = {
  /** Keyed by leaf uuid (the activity-store key). */
  byLeaf: Record<string, UsageInfo>;
  set: (uuid: string, info: UsageInfo) => void;
  drop: (uuid: string) => void;
};

export const useUsageStore = create<UsageStoreState>((set) => ({
  byLeaf: {},
  set: (uuid, info) =>
    set((s) => ({ byLeaf: { ...s.byLeaf, [uuid]: info } })),
  drop: (uuid) =>
    set((s) => {
      if (!s.byLeaf[uuid]) return s;
      const next = { ...s.byLeaf };
      delete next[uuid];
      return { byLeaf: next };
    }),
}));

/** Last segment of the model id, with any context-window suffix stripped, so
 *  "claude-opus-4-8[1m]" reads as "opus 4-8" rather than the full slug. */
export function shortModelName(model: string): string {
  const base = model.replace(/\[.*?\]$/, "");
  const m = base.match(/(opus|sonnet|haiku)[-_]?([\d.-]+)?/i);
  if (m) {
    const family = m[1].toLowerCase();
    const ver = m[2]?.replace(/-+$/, "");
    return ver ? `${family} ${ver}` : family;
  }
  // Unknown shape: collapse the vendor prefix but keep something recognizable.
  return base.replace(/^claude[-_]/, "");
}

/** "$0.12" / "$1.4k" style, compact and rounded. None -> null (HUD omits it). */
export function formatCost(usd: number | null): string | null {
  if (usd == null || !Number.isFinite(usd) || usd < 0) return null;
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 10) return `$${usd.toFixed(0)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd === 0) return "$0.00";
  return "<$0.01";
}

/** Rounded integer percent for display, clamped defensively to 0..100. */
export function formatContextPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/** Above this, the session is close enough to auto-compact to warrant a warning. */
export const CONTEXT_WARN_PCT = 85;
