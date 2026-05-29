import { create } from "zustand";
import {
  type ActivityState,
  computeHeuristicState,
  isShellCommand,
  rollUpStates,
} from "../lib/activityState";

/** A hook-reported state is authoritative for this long before the heuristic resumes. */
export const HOOK_STALE_MS = 15_000;

export type ActivitySource = "hook" | "heuristic";

export type LeafActivity = {
  state: ActivityState;
  lastOutputAt: number;
  /** Last time a hook line set this leaf's state (0 if never). */
  lastHookAt: number;
  source: ActivitySource;
  seen: boolean;
  /** A non-shell command ran since the leaf last sat idle. */
  hadCommand: boolean;
  /** Absolute paths the agent has edited this turn (Edit/Write/MultiEdit),
   *  deduped and capped. Cleared when a fresh turn starts. */
  changedFiles: string[];
  /** Structured hook meta (terax:agent-meta), present only while a Claude Code
   *  agent is reporting. Each is set independently as events carry it. */
  currentTool?: string;
  sessionId?: string;
  transcriptPath?: string;
  agentCwd?: string;
};

/** Cap on per-leaf changed-file accumulation, oldest dropped first. */
const MAX_CHANGED_FILES = 50;

/** Structured fields forwarded by the hook socket (terax:agent-meta). */
export type AgentMeta = {
  tool?: string | null;
  cwd?: string | null;
  session?: string | null;
  transcript?: string | null;
  file?: string | null;
};

type ActivityStoreState = {
  leaves: Record<string, LeafActivity>;
  /** PTY output arrived for a leaf at time `at`. */
  recordOutput: (uuid: string, at: number) => void;
  /** A hook line set an authoritative state. */
  applyHook: (uuid: string, state: ActivityState, at: number) => void;
  /** Structured hook meta arrived for a leaf; merges only the present fields. */
  setMeta: (uuid: string, meta: AgentMeta) => void;
  /** A tmux foreground poll: map uuid->foreground command name. */
  applyPoll: (foreground: Record<string, string>, now: number) => void;
  /** The user activated/viewed this leaf's tab: clear done -> idle. */
  markSeen: (uuid: string) => void;
  /** Remove a closed leaf. */
  dropLeaf: (uuid: string) => void;
  /** Most-urgent state across the given leaf uuids (for a tab). */
  rollUpFor: (uuids: string[]) => ActivityState;
};

const blank = (): LeafActivity => ({
  state: "idle",
  lastOutputAt: 0,
  lastHookAt: 0,
  source: "heuristic",
  seen: true,
  hadCommand: false,
  changedFiles: [],
});

/** Append a path to a changed-file list, deduped by exact match and capped
 *  most-recent-last. Returns the original list when nothing changed. */
function appendChangedFile(files: string[], file: string): string[] {
  const next = files.filter((f) => f !== file);
  next.push(file);
  if (next.length > MAX_CHANGED_FILES) next.splice(0, next.length - MAX_CHANGED_FILES);
  return next;
}

export const useActivityStore = create<ActivityStoreState>((set, get) => ({
  leaves: {},

  recordOutput: (uuid, at) =>
    set((s) => {
      const prev = s.leaves[uuid] ?? blank();
      return {
        leaves: {
          ...s.leaves,
          [uuid]: { ...prev, lastOutputAt: at },
        },
      };
    }),

  applyHook: (uuid, state, at) =>
    set((s) => {
      const prev = s.leaves[uuid] ?? blank();
      // A new turn begins when work resumes from a settled state; the previous
      // turn's edits are stale, so reset the inbox. A blocked -> working bounce
      // mid-turn keeps accumulating.
      const newTurn =
        state === "working" && (prev.state === "done" || prev.state === "idle");
      return {
        leaves: {
          ...s.leaves,
          [uuid]: {
            ...prev,
            state,
            source: "hook",
            lastHookAt: at,
            // A non-idle hook state implies the leaf has unseen activity.
            seen: state === "idle" ? prev.seen : false,
            ...(newTurn ? { changedFiles: [] } : {}),
          },
        },
      };
    }),

  setMeta: (uuid, meta) =>
    set((s) => {
      const prev = s.leaves[uuid] ?? blank();
      // Merge only the fields this event actually carried, so e.g. a
      // SessionStart (session + cwd, no tool) never wipes a known currentTool.
      return {
        leaves: {
          ...s.leaves,
          [uuid]: {
            ...prev,
            ...(meta.tool != null ? { currentTool: meta.tool } : {}),
            ...(meta.cwd != null ? { agentCwd: meta.cwd } : {}),
            ...(meta.session != null ? { sessionId: meta.session } : {}),
            ...(meta.transcript != null ? { transcriptPath: meta.transcript } : {}),
            ...(meta.file
              ? { changedFiles: appendChangedFile(prev.changedFiles, meta.file) }
              : {}),
          },
        },
      };
    }),

  applyPoll: (foreground, now) =>
    set((s) => {
      const next = { ...s.leaves };
      for (const [uuid, cmd] of Object.entries(foreground)) {
        const prev = next[uuid] ?? blank();
        const hadCommand = isShellCommand(cmd) ? prev.hadCommand : true;
        // A fresh hook state stays authoritative; skip the heuristic.
        if (prev.source === "hook" && now - prev.lastHookAt < HOOK_STALE_MS) {
          next[uuid] = { ...prev, hadCommand };
          continue;
        }
        const heuristic = computeHeuristicState(
          {
            foreground: cmd,
            lastOutputAt: prev.lastOutputAt,
            seen: prev.seen,
            hadCommand,
          },
          now,
        );
        next[uuid] = {
          ...prev,
          state: heuristic,
          source: "heuristic",
          // Only forget "a command ran" once we're truly back at the shell
          // prompt. A running command that merely went quiet (now "idle")
          // must keep hadCommand so it still resolves to "done" on exit.
          hadCommand:
            heuristic === "idle" && isShellCommand(cmd) ? false : hadCommand,
        };
      }
      return { leaves: next };
    }),

  markSeen: (uuid) =>
    set((s) => {
      const prev = s.leaves[uuid];
      if (!prev) return s;
      const cleared = prev.state === "done" ? "idle" : prev.state;
      return {
        leaves: {
          ...s.leaves,
          [uuid]: { ...prev, seen: true, state: cleared },
        },
      };
    }),

  dropLeaf: (uuid) =>
    set((s) => {
      if (!s.leaves[uuid]) return s;
      const next = { ...s.leaves };
      delete next[uuid];
      return { leaves: next };
    }),

  rollUpFor: (uuids) => {
    const { leaves } = get();
    return rollUpStates(uuids.map((u) => leaves[u]?.state ?? "idle"));
  },
}));
