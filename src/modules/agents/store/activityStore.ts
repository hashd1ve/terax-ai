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
};

type ActivityStoreState = {
  leaves: Record<string, LeafActivity>;
  /** PTY output arrived for a leaf at time `at`. */
  recordOutput: (uuid: string, at: number) => void;
  /** A hook line set an authoritative state. */
  applyHook: (uuid: string, state: ActivityState, at: number) => void;
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
});

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
          hadCommand: heuristic === "idle" ? false : hadCommand,
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
