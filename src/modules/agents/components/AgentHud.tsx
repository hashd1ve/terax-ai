import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useActivityStore } from "../store/activityStore";
import {
  CONTEXT_WARN_PCT,
  formatContextPct,
  formatCost,
  shortModelName,
  type UsageInfo,
  useUsageStore,
} from "../store/usageStore";

/** Slow enough that a working agent costs a fraction of one fs read per second,
 *  fast enough that the context bar tracks the CLI within a turn or two. */
const POLL_MS = 4000;

async function refresh(uuid: string, transcriptPath: string): Promise<void> {
  try {
    const info = await invoke<UsageInfo | null>("agent_read_usage", {
      transcriptPath,
    });
    if (info) useUsageStore.getState().set(uuid, info);
  } catch {
    // Rejected path, unreadable file, or schema drift: keep the last known
    // numbers rather than flashing the HUD empty on a transient miss.
  }
}

/**
 * Read-only context/cost overlay for a terminal leaf running Claude Code. It
 * derives everything from the agent's transcript JSONL (path already on the
 * activity store via the terax:agent-meta hook), polling only while the leaf is
 * actively working. Renders null and starts no timer when the leaf has no
 * transcript or the HUD is disabled, so a plain shell costs nothing.
 */
export function AgentHud({ uuid }: { uuid: string }) {
  const hudEnabled = usePreferencesStore((s) => s.hudEnabled);

  // Subscribe narrowly so unrelated activity (cwd polls, other panes) never
  // re-renders the HUD.
  const transcriptPath = useActivityStore((s) => s.leaves[uuid]?.transcriptPath);
  const working = useActivityStore((s) => s.leaves[uuid]?.state === "working");
  const usage = useUsageStore((s) => s.byLeaf[uuid]);

  const active = hudEnabled && !!transcriptPath;

  useEffect(() => {
    if (!active || !transcriptPath) return;
    // Read once on mount/activation so a settled agent still shows its final
    // numbers; then keep polling only while it is actively working.
    void refresh(uuid, transcriptPath);
    if (!working) return;
    const handle = setInterval(() => void refresh(uuid, transcriptPath), POLL_MS);
    return () => clearInterval(handle);
  }, [active, working, transcriptPath, uuid]);

  // Free the cached usage when this leaf stops being an agent pane.
  useEffect(() => {
    if (active) return;
    return () => useUsageStore.getState().drop(uuid);
  }, [active, uuid]);

  if (!active || !usage) return null;

  const pct = formatContextPct(usage.contextPct);
  const warn = pct > CONTEXT_WARN_PCT;
  const cost = formatCost(usage.costUsdEst);

  return (
    <div
      className="pointer-events-none absolute bottom-1.5 right-2 z-10 flex select-none items-center gap-1.5 rounded-md border border-border/50 bg-background/80 px-2 py-0.5 font-mono text-[10.5px] leading-none tracking-tight text-muted-foreground shadow-sm backdrop-blur-sm"
      aria-hidden
    >
      <span
        className={cn(
          "tabular-nums",
          warn ? "font-medium text-destructive" : "text-foreground/80",
        )}
        title={`${usage.contextTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} context tokens`}
      >
        ctx {pct}%
      </span>
      <span className="text-muted-foreground/50">·</span>
      <span title={usage.model}>{shortModelName(usage.model)}</span>
      {cost && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span
            className="tabular-nums"
            title="Estimated cost of the last turn (list prices, approximate)"
          >
            ~{cost}
          </span>
        </>
      )}
    </div>
  );
}
