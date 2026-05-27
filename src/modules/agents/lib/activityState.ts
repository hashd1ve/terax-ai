/** The four per-leaf states shown on the tab bar. */
export type ActivityState = "working" | "blocked" | "done" | "idle";

/** Inputs the heuristic state machine reasons over for a single leaf. */
export type LeafActivity = {
  /** Foreground process command name from tmux, e.g. "zsh", "claude", "npm". "" = unknown/none. */
  foreground: string;
  /** Epoch ms of the last PTY output byte for this leaf, or 0 if none yet. */
  lastOutputAt: number;
  /** Whether the user has viewed (activated) this leaf's tab since work last finished. */
  seen: boolean;
  /** Whether a non-shell command has run in this leaf since it last sat idle. */
  hadCommand: boolean;
};

/** Output considered "active" => working. */
export const WORKING_QUIET_MS = 2_000;
/** Quiet beyond this, with a known agent in foreground => blocked. */
export const BLOCKED_QUIET_MS = 10_000;

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "pwsh", "nu"]);

/** Configurable list of agent command basenames that can go "blocked". */
export const KNOWN_AGENTS = ["claude", "codex", "aider"];

/** Empty foreground is treated as shell-equivalent (no command running). */
export function isShellCommand(cmd: string): boolean {
  return cmd === "" || SHELLS.has(cmd);
}

export function isKnownAgent(cmd: string): boolean {
  return KNOWN_AGENTS.includes(cmd);
}

/**
 * Pure heuristic: foreground process + output recency => state.
 * Hook signals override this elsewhere (see activityStore).
 */
export function computeHeuristicState(a: LeafActivity, now: number): ActivityState {
  if (isShellCommand(a.foreground)) {
    return a.hadCommand && !a.seen ? "done" : "idle";
  }
  const quietFor = now - a.lastOutputAt;
  if (quietFor <= WORKING_QUIET_MS) return "working";
  if (quietFor > BLOCKED_QUIET_MS && isKnownAgent(a.foreground)) return "blocked";
  // Silent non-agent command (quiet build) — or quiet agent below blocked window — stays working.
  return "working";
}

const URGENCY: Record<ActivityState, number> = {
  blocked: 3,
  working: 2,
  done: 1,
  idle: 0,
};

/** Roll a tab's leaf states up to the most urgent. Empty => idle. */
export function rollUpStates(states: ActivityState[]): ActivityState {
  let best: ActivityState = "idle";
  for (const s of states) {
    if (URGENCY[s] > URGENCY[best]) best = s;
  }
  return best;
}
