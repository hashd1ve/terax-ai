# Per-tab Agent Activity Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on each terminal tab, whether a command/agent is working, blocked on input, done, or idle — using a heuristic (tmux foreground process + output activity) overridden by precise Claude Code hook signals over a Rust Unix socket.

**Architecture:** A frontend store keyed by stable per-leaf `uuid` holds each leaf's `{ state, lastOutputAt, source, seen }`. A PURE state-machine function maps `(foreground process, lastOutputAt, hook input)` to one of four states. A new Rust command batch-polls `tmux -L terax list-panes` on a ~1.5s frontend interval. A Rust Unix-domain-socket listener (started at app boot, survives webview reloads) parses one-JSON-line-per-message hook reports and emits a Tauri `agent-state` event. PTY spawn injects `TERAX_PANE=<uuid>` and `TERAX_AGENT_SOCK=<path>`. The TabBar renders a spinner/red-dot/blue-dot/nothing using the existing dirty-dot layout, rolling up split panes to their most urgent leaf state.

**Tech Stack:** React + TypeScript + Zustand (frontend), Rust + Tauri 2 + `tokio` + `serde_json` (backend), Vitest (frontend tests), `cargo test` (Rust tests), tmux (heuristic backend, optional).

---

## Background: existing infrastructure to reuse (read before starting)

This feature is **adjacent to** an already-shipped agent-notification system. Do NOT duplicate it; reuse its patterns.

- **Event emission pattern (Rust → frontend):** `app.emit("terax:agent-signal", payload)` in `src-tauri/src/modules/pty/session.rs:181` and `window.emit("terax:settings-tab", t)` in `src-tauri/src/lib.rs:45`. Mirror this exactly for the new `terax:agent-state` event.
- **Frontend listen pattern:** `src/modules/agents/components/AgentNotificationsBridge.tsx` uses `listen<T>("terax:agent-signal", cb)` from `@tauri-apps/api/event` inside a `useEffect`, storing `unlisten` and cleaning up. Mirror this.
- **Existing OSC-based agent detection:** `src-tauri/src/modules/pty/agent_detect.rs` (`AgentDetector`) already turns OSC 133/777 sequences into `working`/`attention`/`finished`/`exited` signals keyed by **ptyId**. The existing Claude Code hooks (installed by `src-tauri/src/modules/agent.rs`) write OSC 777 markers through the PTY. **This new feature does NOT replace that.** It adds a *separate, complementary* per-leaf **state indicator** keyed by the stable `uuid`, driven by (a) tmux foreground polling and (b) a dedicated socket. The socket path is more robust than OSC-through-tmux because it survives webview reloads and does not depend on shell integration.
- **Hook installer pattern:** `src-tauri/src/modules/agent.rs` (`agent_enable_claude_hooks` / `agent_claude_hooks_status`) already merges hooks into `~/.claude/settings.json` idempotently and is invoked from `NotificationBell.tsx`. We will EXTEND this installer's hook command to also write the pane-state JSON line to `$TERAX_AGENT_SOCK`, rather than inventing a parallel installer.
- **Tab/leaf model:** `src/modules/terminal/lib/panes.ts` (`PaneNode`), `src/modules/tabs/lib/useTabs.ts` (`TerminalTab`, `leafIds`, `hasLeaf`).
- **PTY spawn / env injection:** `src-tauri/src/modules/pty/shell_init.rs` (`apply_common` injects `TERAX_TERMINAL=1`; this is where `TERAX_PANE` / `TERAX_AGENT_SOCK` go), threaded from `pty_open` in `src-tauri/src/modules/pty/mod.rs`.
- **Output-activity path:** `deliverPtyBytes(leafId, bytes)` in `src/modules/terminal/lib/useTerminalSession.ts:180`. This is where `lastOutputAt` is recorded.
- **Pure-logic test style:** `src/modules/tabs/lib/tabLabel.test.ts` (Vitest, factory helper, table-ish `it()` cases).
- **Rust test style:** `#[cfg(test)] mod tests` co-located in the same file (see `agent_detect.rs`, `agent.rs`, `shell_init.rs`).

---

## SHARED PREREQUISITE: stable per-leaf `uuid`

This feature and `2026-05-27-session-persistence-design.md` both require a **stable `uuid` field on each leaf `PaneNode`**. Persistence is expected to ship first and introduce it. **Task 1 below is the fallback** — it introduces the `uuid` only if it is not already present.

**Before starting Task 1, check:**
```bash
grep -n "uuid" src/modules/terminal/lib/panes.ts
```
- If `uuid` is already a field on the `leaf` variant of `PaneNode` and is generated at every leaf-creation site in `useTabs.ts`: **skip Task 1 entirely** and use the existing `uuid` throughout.
- If not present: **do Task 1** to introduce it.

All later tasks key state by `uuid`. The bridge (Task 12) resolves `uuid → tabId/leafId` for activation by walking the pane tree.

---

## File Structure

**Frontend — new files:**
- `src/modules/agents/lib/activityState.ts` — PURE state machine + roll-up + known-agent classification.
- `src/modules/agents/lib/activityState.test.ts` — Vitest unit tests for the above.
- `src/modules/agents/store/activityStore.ts` — Zustand store keyed by leaf `uuid`.
- `src/modules/agents/store/activityStore.test.ts` — Vitest tests for store reducers (apply-hook, apply-poll, mark-seen).
- `src/modules/agents/components/AgentActivityBridge.tsx` — mounts the tmux poll interval + listens to `terax:agent-state`; drives the store.
- `src/modules/terminal/lib/foregroundPoll.ts` — thin wrapper invoking the `tmux_list_panes` command + parsing helper re-export.

**Frontend — modified files:**
- `src/modules/terminal/lib/panes.ts` — add `uuid` to leaf (Task 1, conditional).
- `src/modules/tabs/lib/useTabs.ts` — generate `uuid` at leaf creation (Task 1, conditional).
- `src/modules/terminal/lib/useTerminalSession.ts` — record `lastOutputAt` in `deliverPtyBytes`; expose a hook for the store.
- `src/modules/tabs/TabBar.tsx` — render the per-tab indicator.
- `src/app/App.tsx` — mount `AgentActivityBridge`; pass roll-up state to `TabBar`.
- `src/modules/agents/index.ts` — export the new bridge.

**Rust — new files:**
- `src-tauri/src/modules/pty/tmux_panes.rs` — `tmux_list_panes` command + PURE `parse_list_panes` parser + foreground classification.
- `src-tauri/src/modules/agent_sock.rs` — Unix socket listener + PURE `parse_state_line` parser + `AgentStateEvent` payload.

**Rust — modified files:**
- `src-tauri/src/modules/pty/shell_init.rs` — inject `TERAX_PANE` / `TERAX_AGENT_SOCK`.
- `src-tauri/src/modules/pty/session.rs` — thread `pane_uuid` + socket path through `spawn`.
- `src-tauri/src/modules/pty/mod.rs` — thread `pane_uuid` through `pty_open`; register `tmux_panes` module.
- `src-tauri/src/modules/mod.rs` — declare `agent_sock` module.
- `src-tauri/src/modules/agent.rs` — extend hook command to also write the socket line.
- `src-tauri/src/lib.rs` — start the socket listener at boot; register `tmux_list_panes` command; `.manage` the socket path.

**Bundled hook asset — new file:**
- `src-tauri/src/modules/scripts/agent-state-hook.sh` — reference copy of the per-pane hook (documented; the live command is generated inline by `agent.rs` to match the existing pattern).

---

## Task 1 (CONDITIONAL): Add stable `uuid` to leaf PaneNode

> **Skip this task if `uuid` already exists on the leaf `PaneNode`** (see SHARED PREREQUISITE check above). If session-persistence shipped first, it owns this; reuse it.

**Files:**
- Modify: `src/modules/terminal/lib/panes.ts:5-12`
- Modify: `src/modules/tabs/lib/useTabs.ts` (every leaf-creation site)
- Test: `src/modules/terminal/lib/panes.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `src/modules/terminal/lib/panes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leafIds, type PaneNode } from "./panes";

describe("PaneNode uuid", () => {
  it("leaf carries a uuid field", () => {
    const leaf: PaneNode = { kind: "leaf", id: 2, uuid: "abc-123" };
    expect(leaf.kind === "leaf" && leaf.uuid).toBe("abc-123");
  });

  it("leafIds still traverses splits", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 1,
      dir: "row",
      children: [
        { kind: "leaf", id: 2, uuid: "a" },
        { kind: "leaf", id: 3, uuid: "b" },
      ],
    };
    expect(leafIds(tree)).toEqual([2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/terminal/lib/panes.test.ts`
Expected: FAIL — TypeScript error, `uuid` not assignable to leaf type.

- [ ] **Step 3: Add `uuid` to the leaf variant**

In `src/modules/terminal/lib/panes.ts`, change the leaf variant of `PaneNode`:

```ts
export type PaneNode =
  | { kind: "leaf"; id: PaneId; uuid: string; cwd?: string }
  | {
      kind: "split";
      id: PaneId;
      dir: SplitDir;
      children: PaneNode[];
    };
```

In `splitLeaf`, generate a uuid for each new leaf it constructs (two `newLeaf` literals):

```ts
const newLeaf: PaneNode = { kind: "leaf", id: newLeafId, uuid: crypto.randomUUID(), cwd: newCwd };
```

- [ ] **Step 4: Generate `uuid` at every leaf-creation site in useTabs.ts**

In `src/modules/tabs/lib/useTabs.ts`, every object literal `{ kind: "leaf", id: leafId, cwd }` must gain `uuid: crypto.randomUUID()`. Sites: `useTabs` initial state, `newTab`, `newAgentTab`, `newPrivateTab`, `resetWorkspace`. Example for `newTab`:

```ts
paneTree: { kind: "leaf", id: leafId, uuid: crypto.randomUUID(), cwd },
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `npx vitest run src/modules/terminal/lib/panes.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/terminal/lib/panes.ts src/modules/terminal/lib/panes.test.ts src/modules/tabs/lib/useTabs.ts
git commit -m "feat(terminal): add stable per-leaf uuid to PaneNode"
```

---

## Task 2: Pure activity state machine + roll-up

**Files:**
- Create: `src/modules/agents/lib/activityState.ts`
- Test: `src/modules/agents/lib/activityState.test.ts`

This is the heart of the feature and is 100% pure/testable — no React, no Tauri.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agents/lib/activityState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type ActivityState,
  type LeafActivity,
  computeHeuristicState,
  isShellCommand,
  isKnownAgent,
  rollUpStates,
  WORKING_QUIET_MS,
  BLOCKED_QUIET_MS,
} from "./activityState";

const base = (over: Partial<LeafActivity> = {}): LeafActivity => ({
  foreground: "zsh",
  lastOutputAt: 1000,
  seen: true,
  hadCommand: false,
  ...over,
});

describe("isShellCommand", () => {
  it("recognizes common shells", () => {
    for (const s of ["zsh", "bash", "fish", "sh", "pwsh", "nu"]) {
      expect(isShellCommand(s)).toBe(true);
    }
  });
  it("treats other commands as non-shell", () => {
    expect(isShellCommand("claude")).toBe(false);
    expect(isShellCommand("npm")).toBe(false);
    expect(isShellCommand("")).toBe(true); // empty == no command == shell-equivalent
  });
});

describe("isKnownAgent", () => {
  it("matches configured agents and ignores others", () => {
    expect(isKnownAgent("claude")).toBe(true);
    expect(isKnownAgent("codex")).toBe(true);
    expect(isKnownAgent("aider")).toBe(true);
    expect(isKnownAgent("npm")).toBe(false);
  });
});

describe("computeHeuristicState", () => {
  const now = 100_000;

  it("shell foreground + already seen => idle", () => {
    expect(computeHeuristicState(base({ foreground: "zsh", seen: true }), now)).toBe("idle");
  });

  it("shell foreground after a command, tab not seen => done", () => {
    expect(
      computeHeuristicState(base({ foreground: "zsh", hadCommand: true, seen: false }), now),
    ).toBe("done");
  });

  it("non-shell + recent output => working", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "npm", lastOutputAt: now - 500 }),
        now,
      ),
    ).toBe("working");
  });

  it("known agent + long quiet => blocked", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "claude", lastOutputAt: now - (BLOCKED_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("blocked");
  });

  it("non-agent command quiet a long time stays working (never blocked)", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "cargo", lastOutputAt: now - (BLOCKED_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("working");
  });

  it("non-shell quiet between working and blocked windows stays working", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "claude", lastOutputAt: now - (WORKING_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("working");
  });
});

describe("rollUpStates urgency: blocked > working > done > idle", () => {
  const cases: [ActivityState[], ActivityState][] = [
    [["idle", "idle"], "idle"],
    [["idle", "done"], "done"],
    [["done", "working"], "working"],
    [["working", "blocked"], "blocked"],
    [["blocked", "idle", "working"], "blocked"],
    [[], "idle"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} => ${expected}`, () => {
      expect(rollUpStates(input)).toBe(expected);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/agents/lib/activityState.test.ts`
Expected: FAIL — module `./activityState` not found.

- [ ] **Step 3: Write the implementation**

Create `src/modules/agents/lib/activityState.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/agents/lib/activityState.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/lib/activityState.ts src/modules/agents/lib/activityState.test.ts
git commit -m "feat(agents): pure activity state machine and tab roll-up"
```

---

## Task 3: Activity store keyed by leaf uuid

**Files:**
- Create: `src/modules/agents/store/activityStore.ts`
- Test: `src/modules/agents/store/activityStore.test.ts`

The store holds `{ state, lastOutputAt, source, seen }` per leaf `uuid` and exposes reducers. Hook source wins over heuristic until it goes stale.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agents/store/activityStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useActivityStore, HOOK_STALE_MS } from "./activityStore";

const reset = () => useActivityStore.setState({ leaves: {} });

describe("activityStore", () => {
  beforeEach(reset);

  it("records output activity and infers heuristic state on poll", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 1000);
    // foreground claude, last output 1000, polled at 1500 => working
    s.applyPoll({ u1: "claude" }, 1500);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("working");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("heuristic");
  });

  it("hook state overrides heuristic and wins until stale", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 0);
    s.applyHook("u1", "blocked", 1000);
    // a poll that would say working must NOT override a fresh hook
    s.applyPoll({ u1: "claude" }, 1000 + 500);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("blocked");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("hook");
  });

  it("heuristic takes over once the hook state is stale", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 0);
    s.applyHook("u1", "blocked", 1000);
    s.applyPoll({ u1: "zsh" }, 1000 + HOOK_STALE_MS + 1); // shell + seen=false default? mark seen below
    s.markSeen("u1"); // viewed -> idle
    s.applyPoll({ u1: "zsh" }, 1000 + HOOK_STALE_MS + 2);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("idle");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("heuristic");
  });

  it("markSeen clears a done state to idle and sets seen", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "done", 1000);
    s.markSeen("u1");
    // done is a hook state; markSeen flips seen and downgrades done->idle
    expect(useActivityStore.getState().leaves["u1"].state).toBe("idle");
  });

  it("rollUpFor computes a tab's most urgent leaf state", () => {
    const s = useActivityStore.getState();
    s.applyHook("a", "idle", 1000);
    s.applyHook("b", "blocked", 1000);
    expect(useActivityStore.getState().rollUpFor(["a", "b"])).toBe("blocked");
    expect(useActivityStore.getState().rollUpFor(["a"])).toBe("idle");
    expect(useActivityStore.getState().rollUpFor(["missing"])).toBe("idle");
  });

  it("dropLeaf removes a leaf entry", () => {
    const s = useActivityStore.getState();
    s.applyHook("a", "working", 1000);
    s.dropLeaf("a");
    expect(useActivityStore.getState().leaves["a"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/agents/store/activityStore.test.ts`
Expected: FAIL — module `./activityStore` not found.

- [ ] **Step 3: Write the implementation**

Create `src/modules/agents/store/activityStore.ts`:

```ts
import { create } from "zustand";
import {
  type ActivityState,
  computeHeuristicState,
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
        const isShell = cmd === "" || ["zsh", "bash", "fish", "sh", "pwsh", "nu"].includes(cmd);
        const hadCommand = isShell ? prev.hadCommand : true;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/agents/store/activityStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/store/activityStore.ts src/modules/agents/store/activityStore.test.ts
git commit -m "feat(agents): activity store keyed by leaf uuid with hook precedence"
```

---

## Task 4: Record lastOutputAt in the PTY output path

**Files:**
- Modify: `src/modules/terminal/lib/useTerminalSession.ts:180-186` (`deliverPtyBytes`)
- Modify: `src/modules/terminal/lib/useTerminalSession.ts` (`Session` type + `ensureSession`, to carry `uuid`)

PTY bytes already arrive in `deliverPtyBytes`. Sessions are keyed by numeric `leafId`, but the activity store is keyed by `uuid`. We thread the leaf `uuid` into the session so `deliverPtyBytes` can call `recordOutput(uuid, Date.now())`.

- [ ] **Step 1: Add `uuid` to the Session and accept it in ensureSession/useTerminalSession**

In `src/modules/terminal/lib/useTerminalSession.ts`, add to the `Session` type (after `initialCwd`):

```ts
  uuid: string | null;
```

In `ensureSession`, change the signature and initial object:

```ts
function ensureSession(leafId: number, uuid?: string, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) {
    if (uuid && !existing.uuid) existing.uuid = uuid;
    return existing;
  }
  // ...inside the session object literal, add:
  //   uuid: uuid ?? null,
```

Add `uuid: uuid ?? null,` to the `const session: Session = { ... }` literal.

- [ ] **Step 2: Record output in deliverPtyBytes**

Replace `deliverPtyBytes` (lines ~180-186):

```ts
function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  if (s.uuid) useActivityStore.getState().recordOutput(s.uuid, Date.now());
  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}
```

Add the import at the top of the file:

```ts
import { useActivityStore } from "@/modules/agents/store/activityStore";
```

- [ ] **Step 3: Thread uuid through the `Options` type and hook usage**

In the `Options` type add `uuid?: string;`. In `useTerminalSession`, destructure `uuid` and pass it: change `ensureSession(leafId, initialCwd)` to `ensureSession(leafId, uuid, initialCwd)`. Add `uuid` to the effect dependency array alongside `leafId`.

- [ ] **Step 4: Pass uuid from the caller**

Find where `useTerminalSession` is called (`src/modules/terminal/TerminalPane.tsx`). The component receives a leaf; pass its `uuid` through to `useTerminalSession({ ..., uuid: leaf.uuid })`. Trace the prop from `TerminalStack` which maps the pane tree.

```bash
grep -rn "useTerminalSession(" src/modules/terminal/
grep -rn "TerminalPane" src/modules/terminal/TerminalStack.tsx
```

Add a `uuid` prop to `TerminalPane` and plumb the leaf's `uuid` from `TerminalStack`'s tree walk.

- [ ] **Step 5: Verify typecheck + existing terminal tests pass**

Run: `npx tsc --noEmit && npx vitest run src/modules/terminal`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/terminal/
git commit -m "feat(terminal): record per-leaf lastOutputAt for activity heuristic"
```

---

## Task 5: Rust — pure tmux list-panes parser

**Files:**
- Create: `src-tauri/src/modules/pty/tmux_panes.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs:1-6` (add `mod tmux_panes;`)

The command runs `tmux -L terax list-panes -a -F '#{session_name} #{pane_current_command}'` and returns a `Vec<(session_name, command)>`. The parser is pure and unit-tested without spawning tmux. Session names are `terax_<uuid>` (matching the persistence design); we strip the `terax_` prefix to recover the leaf `uuid`.

- [ ] **Step 1: Write the failing test (parser only)**

Create `src-tauri/src/modules/pty/tmux_panes.rs`:

```rust
//! Batched tmux foreground-process polling for the activity heuristic.

/// One foreground reading: (leaf uuid, foreground command basename).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneForeground {
    pub uuid: String,
    pub command: String,
}

/// Parse the output of
/// `tmux -L terax list-panes -a -F '#{session_name} #{pane_current_command}'`.
/// Only `terax_<uuid>` sessions are kept; the `terax_` prefix is stripped.
pub fn parse_list_panes(stdout: &str) -> Vec<PaneForeground> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (session, command) = match line.split_once(' ') {
            Some((s, c)) => (s, c.trim()),
            None => (line, ""),
        };
        let Some(uuid) = session.strip_prefix("terax_") else {
            continue;
        };
        if uuid.is_empty() {
            continue;
        }
        out.push(PaneForeground {
            uuid: uuid.to_string(),
            command: command.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_and_command() {
        let out = parse_list_panes("terax_abc-123 zsh\nterax_def-456 claude\n");
        assert_eq!(
            out,
            vec![
                PaneForeground { uuid: "abc-123".into(), command: "zsh".into() },
                PaneForeground { uuid: "def-456".into(), command: "claude".into() },
            ]
        );
    }

    #[test]
    fn ignores_non_terax_sessions() {
        let out = parse_list_panes("work bash\nterax_x npm\n");
        assert_eq!(out, vec![PaneForeground { uuid: "x".into(), command: "npm".into() }]);
    }

    #[test]
    fn handles_missing_command_and_blank_lines() {
        let out = parse_list_panes("terax_y\n\n  \nterax_z  cargo  \n");
        assert_eq!(
            out,
            vec![
                PaneForeground { uuid: "y".into(), command: "".into() },
                PaneForeground { uuid: "z".into(), command: "cargo".into() },
            ]
        );
    }

    #[test]
    fn ignores_empty_uuid() {
        assert!(parse_list_panes("terax_ zsh\n").is_empty());
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/modules/pty/mod.rs`, add near the top with the other `mod` lines (after `mod agent_detect;`):

```rust
pub(crate) mod tmux_panes;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test -p <crate-name> tmux_panes`
(Find the crate name: `grep '^name' src-tauri/Cargo.toml`. It is typically `terax` — use that if unsure: `cargo test --manifest-path src-tauri/Cargo.toml tmux_panes`.)
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/tmux_panes.rs src-tauri/src/modules/pty/mod.rs
git commit -m "feat(pty): pure parser for batched tmux list-panes output"
```

---

## Task 6: Rust — tmux_list_panes Tauri command

**Files:**
- Modify: `src-tauri/src/modules/pty/tmux_panes.rs` (add the command + serializable result)
- Modify: `src-tauri/src/lib.rs:125-188` (register `tmux_list_panes` in `invoke_handler`)

The command shells out once, parses, and returns the foreground map to the frontend. If tmux is absent it returns an empty list (no-tmux fallback — the heuristic then relies on output activity only, handled frontend-side).

- [ ] **Step 1: Add the command to tmux_panes.rs**

Append to `src-tauri/src/modules/pty/tmux_panes.rs` (above the `#[cfg(test)]` block):

```rust
use std::process::Command;

/// Batched foreground poll. Returns `[]` if tmux is unavailable so the
/// frontend heuristic falls back to output-activity only.
#[tauri::command]
pub fn tmux_list_panes() -> Vec<PaneForeground> {
    let output = Command::new("tmux")
        .args([
            "-L",
            "terax",
            "list-panes",
            "-a",
            "-F",
            "#{session_name} #{pane_current_command}",
        ])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            parse_list_panes(&String::from_utf8_lossy(&o.stdout))
        }
        Ok(_) => Vec::new(), // tmux ran but no server/sessions
        Err(e) => {
            log::debug!("tmux_list_panes: tmux unavailable: {e}");
            Vec::new()
        }
    }
}
```

`PaneForeground` must derive `serde::Serialize`. Update its derive line:

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PaneForeground {
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, add after `pty::pty_close_all,`:

```rust
            pty::tmux_panes::tmux_list_panes,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (warnings about unused frontend wiring are fine for now).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/tmux_panes.rs src-tauri/src/lib.rs
git commit -m "feat(pty): tmux_list_panes command for foreground polling"
```

---

## Task 7: Rust — pure agent-socket JSON-line parser

**Files:**
- Create: `src-tauri/src/modules/agent_sock.rs`
- Modify: `src-tauri/src/modules/mod.rs` (add `pub mod agent_sock;`)

A hook writes one JSON object per line to the socket: `{"pane":"<uuid>","state":"working|blocked|done"}`. We parse a single line into a strongly-typed event. This task is the PURE parser + payload type only; the listener thread is Task 8.

- [ ] **Step 1: Write the parser + tests**

Create `src-tauri/src/modules/agent_sock.rs`:

```rust
//! Local Unix-domain-socket listener for Claude Code hook state reports.
//! Hooks write one JSON line per event: {"pane":"<uuid>","state":"working"}.

use serde::{Deserialize, Serialize};

/// Emitted to the frontend as the `terax:agent-state` Tauri event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentStateEvent {
    pub pane: String,
    pub state: String,
}

#[derive(Deserialize)]
struct RawLine {
    pane: String,
    state: String,
}

const VALID_STATES: [&str; 3] = ["working", "blocked", "done"];

/// Parse one newline-delimited JSON message. Returns `None` for blank lines,
/// malformed JSON, empty pane, or an unrecognized state.
pub fn parse_state_line(line: &str) -> Option<AgentStateEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    if raw.pane.is_empty() || !VALID_STATES.contains(&raw.state.as_str()) {
        return None;
    }
    Some(AgentStateEvent { pane: raw.pane, state: raw.state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_line() {
        assert_eq!(
            parse_state_line(r#"{"pane":"abc","state":"blocked"}"#),
            Some(AgentStateEvent { pane: "abc".into(), state: "blocked".into() })
        );
    }

    #[test]
    fn trims_and_ignores_blank() {
        assert_eq!(parse_state_line("   \n"), None);
        assert_eq!(parse_state_line(""), None);
    }

    #[test]
    fn rejects_malformed_json() {
        assert_eq!(parse_state_line("{not json"), None);
        assert_eq!(parse_state_line(r#"{"pane":"abc"}"#), None); // missing state
    }

    #[test]
    fn rejects_unknown_state_and_empty_pane() {
        assert_eq!(parse_state_line(r#"{"pane":"abc","state":"sleeping"}"#), None);
        assert_eq!(parse_state_line(r#"{"pane":"","state":"working"}"#), None);
    }

    #[test]
    fn parses_done_and_working() {
        assert!(parse_state_line(r#"{"pane":"x","state":"done"}"#).is_some());
        assert!(parse_state_line(r#"{"pane":"x","state":"working"}"#).is_some());
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/modules/mod.rs`, add (keep alphabetical with siblings):

```rust
pub mod agent_sock;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent_sock`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/agent_sock.rs src-tauri/src/modules/mod.rs
git commit -m "feat(agent-sock): pure JSON-line parser for hook state reports"
```

---

## Task 8: Rust — socket listener thread + boot wiring

**Files:**
- Modify: `src-tauri/src/modules/agent_sock.rs` (add listener + socket path resolver)
- Modify: `src-tauri/src/lib.rs:86-124` (start the listener in `.setup`; `.manage` the path)

The listener runs on a dedicated thread started at app boot (independent of the webview, so it survives reloads). It reads newline-delimited messages from each accepted connection, parses with `parse_state_line`, and emits `terax:agent-state`. On Windows (no `UnixListener`) it is a no-op — hooks still work elsewhere; this matches the spec's hook layer being best-effort there.

- [ ] **Step 1: Add the socket path resolver + listener (Unix) to agent_sock.rs**

Append to `src-tauri/src/modules/agent_sock.rs` (above `#[cfg(test)]`):

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const AGENT_STATE_EVENT: &str = "terax:agent-state";

/// Stable socket path inside the app's local data dir. Survives reloads.
pub fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("agent-state.sock"))
}

#[cfg(unix)]
pub fn start_listener(app: AppHandle, path: PathBuf) {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    // Remove a stale socket from a previous run; bind fails if it exists.
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("agent-state socket bind failed at {}: {e}", path.display());
            return;
        }
    };
    log::info!("agent-state socket listening at {}", path.display());

    std::thread::Builder::new()
        .name("terax-agent-sock".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let stream = match conn {
                    Ok(s) => s,
                    Err(e) => {
                        log::debug!("agent-state accept failed: {e}");
                        continue;
                    }
                };
                let app = app.clone();
                // Each connection may carry multiple lines (one per hook fire).
                std::thread::spawn(move || {
                    let reader = BufReader::new(stream);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if let Some(ev) = parse_state_line(&line) {
                            let _ = app.emit(AGENT_STATE_EVENT, ev);
                        }
                    }
                });
            }
        })
        .expect("spawn agent-sock listener thread");
}

#[cfg(not(unix))]
pub fn start_listener(_app: AppHandle, _path: PathBuf) {
    // Windows: no Unix socket. Hooks degrade to OSC markers via the existing
    // AgentDetector path; the heuristic still drives the indicator.
}
```

- [ ] **Step 2: Start the listener at boot and manage the path**

In `src-tauri/src/lib.rs`, add a `.setup(...)` closure to the `tauri::Builder` chain (place it before `.invoke_handler(...)`). If a `.setup` already exists, add the body to it:

```rust
        .setup(|app| {
            let handle = app.handle().clone();
            match crate::modules::agent_sock::socket_path(&handle) {
                Ok(path) => {
                    app.manage(crate::modules::agent_sock::AgentSockPath(path.clone()));
                    crate::modules::agent_sock::start_listener(handle, path);
                }
                Err(e) => log::warn!("agent-state socket unavailable: {e}"),
            }
            Ok(())
        })
```

Add the managed wrapper type at the bottom of `src-tauri/src/modules/agent_sock.rs`:

```rust
/// Managed so `pty_open` can read the socket path to inject into the child env.
pub struct AgentSockPath(pub PathBuf);
```

(Place `AgentSockPath` above the `#[cfg(test)]` block; it must be outside `#[cfg(unix)]` so Windows can still inject the env var harmlessly / skip it.)

- [ ] **Step 3: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/agent_sock.rs src-tauri/src/lib.rs
git commit -m "feat(agent-sock): Unix socket listener emitting terax:agent-state"
```

---

## Task 9: Rust — inject TERAX_PANE / TERAX_AGENT_SOCK at PTY spawn

**Files:**
- Modify: `src-tauri/src/modules/pty/shell_init.rs:85-104` (`apply_common`)
- Modify: `src-tauri/src/modules/pty/session.rs:96-119` (`spawn` signature + `build_command` call)
- Modify: `src-tauri/src/modules/pty/mod.rs:36-70` (`pty_open` signature; read `AgentSockPath`; pass uuid)
- Modify: `src/modules/terminal/lib/pty-bridge.ts:39-46` (pass `pane_uuid`)
- Modify: `src/modules/terminal/lib/useTerminalSession.ts` (pass uuid to `openPty`)

The child process needs `TERAX_PANE=<leaf uuid>` and `TERAX_AGENT_SOCK=<socket path>` so the bundled hook can report state.

- [ ] **Step 1: Extend build_command / apply_common to accept and inject the two vars**

In `src-tauri/src/modules/pty/shell_init.rs`, change `build_command` and `apply_common` to thread two new args. Update `build_command`:

```rust
pub fn build_command(
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    pane_uuid: Option<String>,
    agent_sock: Option<String>,
) -> Result<CommandBuilder, String> {
    #[cfg(unix)]
    {
        let _ = workspace;
        let mut cmd = unix::build(cwd)?;
        inject_pane_env(&mut cmd, pane_uuid, agent_sock);
        Ok(cmd)
    }
    #[cfg(windows)]
    {
        let mut cmd = windows::build(cwd, workspace)?;
        inject_pane_env(&mut cmd, pane_uuid, agent_sock);
        Ok(cmd)
    }
}

fn inject_pane_env(
    cmd: &mut CommandBuilder,
    pane_uuid: Option<String>,
    agent_sock: Option<String>,
) {
    if let Some(uuid) = pane_uuid.filter(|s| !s.is_empty()) {
        cmd.env("TERAX_PANE", uuid);
    }
    if let Some(sock) = agent_sock.filter(|s| !s.is_empty()) {
        cmd.env("TERAX_AGENT_SOCK", sock);
    }
}
```

- [ ] **Step 2: Thread the args through `session::spawn`**

In `src-tauri/src/modules/pty/session.rs`, add two params to `spawn` (after `workspace`):

```rust
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    pane_uuid: Option<String>,
    agent_sock: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
```

Change the `build_command` call (line ~119):

```rust
    let cmd = shell_init::build_command(cwd, workspace, pane_uuid, agent_sock)?;
```

- [ ] **Step 3: Thread through `pty_open` and read the managed socket path**

In `src-tauri/src/modules/pty/mod.rs`, add `pane_uuid: Option<String>` param to `pty_open` (after `workspace`) and read the managed socket path. Add to the params list:

```rust
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    pane_uuid: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
```

Add `agent_sock: tauri::State<'_, crate::modules::agent_sock::AgentSockPath>` to the command args. Inside the body, before the `spawn_blocking`:

```rust
    let agent_sock_path = agent_sock.0.to_string_lossy().to_string();
```

Change the spawn closure call:

```rust
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, app, cols, rows, cwd, workspace, pane_uuid, Some(agent_sock_path), on_data, on_exit)
            .map(|(s, _)| s)
    })
```

> Note: `AgentSockPath` is `.manage`d in Task 8. If a test or boot path runs without it, add a fallback default in lib.rs `.manage(AgentSockPath(PathBuf::new()))` guarded so injection is simply skipped (empty string filtered out by `inject_pane_env`).

- [ ] **Step 4: Pass `pane_uuid` from the frontend bridge**

In `src/modules/terminal/lib/pty-bridge.ts`, add a `uuid` param to `openPty` and include it in the `invoke`:

```ts
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  uuid?: string,
): Promise<PtySession> {
```

and in the invoke object:

```ts
  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    paneUuid: uuid ?? null,
    onData,
    onExit,
  });
```

(Tauri maps camelCase JS args to snake_case Rust params: `paneUuid` -> `pane_uuid`.)

In `src/modules/terminal/lib/useTerminalSession.ts`, update both `openPty(...)` calls (in `openPtyForSession`) to pass `s.uuid ?? undefined`:

```ts
  return openPty(startCols, startRows, { /* handlers */ }, cwd, s.uuid ?? undefined);
```

- [ ] **Step 5: Verify it compiles + typechecks**

Run: `cargo build --manifest-path src-tauri/Cargo.toml && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/modules/pty/ src/modules/terminal/lib/pty-bridge.ts src/modules/terminal/lib/useTerminalSession.ts
git commit -m "feat(pty): inject TERAX_PANE and TERAX_AGENT_SOCK into spawned shells"
```

---

## Task 10: Bundle the Claude Code per-pane hook + extend the installer

**Files:**
- Create: `src-tauri/src/modules/scripts/agent-state-hook.sh` (reference/documentation copy)
- Modify: `src-tauri/src/modules/agent.rs` (extend `hook_cmd` to also write the socket line; extend `agent_claude_hooks_status`)

The existing installer (`agent.rs`) already writes OSC 777 markers for `UserPromptSubmit`/`Notification`/`Stop`. We **augment** the same hook command so it ALSO appends a per-pane JSON line to `$TERAX_AGENT_SOCK` when `$TERAX_PANE` is set. This keeps a single installer and one settings.json snippet (per the spec's detect-and-suggest flow that already exists in `NotificationBell.tsx`).

Event→state mapping (per spec): `UserPromptSubmit`/`PreToolUse` ⇒ `working`; `Notification` ⇒ `blocked`; `Stop`/`SubagentStop` ⇒ `done`.

- [ ] **Step 1: Add a documentation copy of the hook**

Create `src-tauri/src/modules/scripts/agent-state-hook.sh`:

```sh
#!/bin/sh
# Reference: the per-pane activity hook Terax merges into ~/.claude/settings.json.
# The LIVE command is generated inline by agent.rs (see hook_cmd); this file
# documents the behavior for maintainers. STATE is one of working|blocked|done.
#
# Writes one JSON line to the Terax agent socket when running inside a Terax
# pane. Uses a Python one-liner for an atomic AF_UNIX SOCK_STREAM connect so a
# missing/closed socket is a no-op (never blocks the agent).
STATE="$1"
if [ -n "$TERAX_PANE" ] && [ -n "$TERAX_AGENT_SOCK" ]; then
  python3 - "$TERAX_AGENT_SOCK" "$TERAX_PANE" "$STATE" <<'PY' 2>/dev/null || true
import socket, sys, json
sock, pane, state = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.2)
    s.connect(sock)
    s.sendall((json.dumps({"pane": pane, "state": state}) + "\n").encode())
    s.close()
except OSError:
    pass
PY
fi
```

- [ ] **Step 2: Extend the inline hook command in agent.rs and remap events**

In `src-tauri/src/modules/agent.rs`, change `HOOK_EVENTS` to add the new events and the per-event activity state, and extend `hook_cmd` to additionally emit the socket line. Note we keep the existing OSC marker (notification system depends on it) and append the socket write.

Replace `HOOK_EVENTS`:

```rust
// (claude event, notify-bell marker, activity-indicator state)
const HOOK_EVENTS: [(&str, &str, &str); 5] = [
    ("UserPromptSubmit", "working", "working"),
    ("PreToolUse", "working", "working"),
    ("Notification", "attention", "blocked"),
    ("Stop", "finished", "done"),
    ("SubagentStop", "finished", "done"),
];
```

Replace `hook_cmd`:

```rust
fn hook_cmd(marker: &str, state: &str) -> String {
    // 1) OSC 777 marker via terminalSequence (existing notification system).
    // 2) Per-pane JSON line to the activity socket when in a Terax pane.
    format!(
        r#"[ -n "$TERAX_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Terax;{marker}\\u0007"}}' ; [ -n "$TERAX_PANE" ] && [ -n "$TERAX_AGENT_SOCK" ] && python3 -c 'import socket,sys,json,os
try:
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(0.2);s.connect(os.environ["TERAX_AGENT_SOCK"]);s.sendall((json.dumps({{"pane":os.environ["TERAX_PANE"],"state":"{state}"}})+"\n").encode());s.close()
except OSError: pass' 2>/dev/null ; true"#
    )
}
```

Update the two call sites in `merge_hooks`:

```rust
    for (event, marker, state) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": hook_cmd(marker, state) } ]
        }));
    }
```

Update `agent_claude_hooks_status` to check all five events' markers (the marker is still the OSC token):

```rust
    HOOK_EVENTS
        .iter()
        .all(|(_, m, _)| content.contains(&format!("notify;Terax;{m}")))
```

- [ ] **Step 3: Fix the existing tests that referenced the old tuple/signature**

The existing tests in `agent.rs` call `hook_cmd("attention")` (one arg) and assert on `Notification`/`Stop`/`UserPromptSubmit` counts. Update them:
- `hook_cmd("attention")` -> `hook_cmd("attention", "blocked")` in `prunes_empty_groups_and_collapses_duplicates`.
- `adds_all_event_hooks_to_empty_config` and `preserves_unrelated_settings_and_foreign_hooks` still pass for the existing three events; counts for `Notification` (now 2 in the preserve test: foreign + ours) remain correct. Add assertions for the new events:

```rust
    #[test]
    fn adds_pretooluse_and_subagentstop_events() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "PreToolUse"), 1);
        assert_eq!(hook_count(&out, "SubagentStop"), 1);
        assert!(command(&out, "PreToolUse", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains(r#""state":"done""#));
        assert!(command(&out, "Notification", 0).contains(r#""state":"blocked""#));
        assert!(command(&out, "UserPromptSubmit", 0).contains("TERAX_AGENT_SOCK"));
    }
```

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent`
Expected: PASS (existing tests updated + new test).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs src-tauri/src/modules/scripts/agent-state-hook.sh
git commit -m "feat(agent): hooks report per-pane activity state to the agent socket"
```

---

## Task 11: Foreground poll wrapper (frontend)

**Files:**
- Create: `src/modules/terminal/lib/foregroundPoll.ts`
- Test: `src/modules/terminal/lib/foregroundPoll.test.ts`

Thin typed wrapper over the `tmux_list_panes` command that converts the result into the `Record<uuid, command>` shape the store's `applyPoll` expects.

- [ ] **Step 1: Write the failing test**

Create `src/modules/terminal/lib/foregroundPoll.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toForegroundMap, type PaneForeground } from "./foregroundPoll";

describe("toForegroundMap", () => {
  it("maps uuid to command", () => {
    const panes: PaneForeground[] = [
      { uuid: "a", command: "zsh" },
      { uuid: "b", command: "claude" },
    ];
    expect(toForegroundMap(panes)).toEqual({ a: "zsh", b: "claude" });
  });

  it("handles an empty list", () => {
    expect(toForegroundMap([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/terminal/lib/foregroundPoll.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/modules/terminal/lib/foregroundPoll.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type PaneForeground = { uuid: string; command: string };

export function toForegroundMap(panes: PaneForeground[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of panes) map[p.uuid] = p.command;
  return map;
}

/** One batched tmux foreground poll. Returns `{}` when tmux is unavailable. */
export async function pollForeground(): Promise<Record<string, string>> {
  try {
    const panes = await invoke<PaneForeground[]>("tmux_list_panes");
    return toForegroundMap(panes);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/terminal/lib/foregroundPoll.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/terminal/lib/foregroundPoll.ts src/modules/terminal/lib/foregroundPoll.test.ts
git commit -m "feat(terminal): foreground poll wrapper over tmux_list_panes"
```

---

## Task 12: AgentActivityBridge — wire poll interval + socket event into the store

**Files:**
- Create: `src/modules/agents/components/AgentActivityBridge.tsx`
- Modify: `src/modules/agents/index.ts` (export it)
- Modify: `src/app/App.tsx` (mount it near `AgentNotificationsBridge`)

Mirrors `AgentNotificationsBridge.tsx`: listens to `terax:agent-state`, and additionally runs a ~1.5s `setInterval` calling `pollForeground()` → `applyPoll`. Also wires tab activation → `markSeen` for the active tab's leaves (done→idle).

- [ ] **Step 1: Write the bridge**

Create `src/modules/agents/components/AgentActivityBridge.tsx`:

```tsx
import type { Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import { pollForeground } from "@/modules/terminal/lib/foregroundPoll";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  type ActivityState,
  useActivityStore,
} from "../store/activityStore";

const POLL_MS = 1500;

type AgentStateEvent = { pane: string; state: ActivityState };

/** Collect every leaf uuid in a pane tree. */
function leafUuids(node: PaneNode): string[] {
  if (node.kind === "leaf") return node.uuid ? [node.uuid] : [];
  return node.children.flatMap(leafUuids);
}

export function AgentActivityBridge({
  tabs,
  activeId,
}: {
  tabs: Tab[];
  activeId: number;
}) {
  // Socket events.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentStateEvent>("terax:agent-state", (e) => {
      const { pane, state } = e.payload;
      useActivityStore.getState().applyHook(pane, state, Date.now());
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Foreground poll interval.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const fg = await pollForeground();
      if (!cancelled) useActivityStore.getState().applyPoll(fg, Date.now());
    };
    void tick();
    const handle = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Tab activation -> mark its leaves seen (done -> idle).
  const seenRef = useRef<number>(-1);
  useEffect(() => {
    if (seenRef.current === activeId) return;
    seenRef.current = activeId;
    const active = tabs.find((t) => t.id === activeId);
    if (active?.kind !== "terminal") return;
    const store = useActivityStore.getState();
    for (const uuid of leafUuids(active.paneTree)) store.markSeen(uuid);
  }, [activeId, tabs]);

  // Drop store entries for leaves that no longer exist (closed tabs/panes).
  useEffect(() => {
    const live = new Set<string>();
    for (const t of tabs) {
      if (t.kind === "terminal") for (const u of leafUuids(t.paneTree)) live.add(u);
    }
    const store = useActivityStore.getState();
    for (const uuid of Object.keys(store.leaves)) {
      if (!live.has(uuid)) store.dropLeaf(uuid);
    }
  }, [tabs]);

  return null;
}
```

> If `leafIds` import is unused after using `leafUuids`, remove it to satisfy lint. (Kept here only if a numeric-id path is also needed.)

- [ ] **Step 2: Export and mount it**

In `src/modules/agents/index.ts`, add:

```ts
export { AgentActivityBridge } from "./components/AgentActivityBridge";
```

In `src/app/App.tsx`, import it alongside `AgentNotificationsBridge` (line 18 area) and render it next to `<AgentNotificationsBridge .../>` (around line 1508):

```tsx
<AgentActivityBridge tabs={tabs} activeId={activeId} />
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run src/modules/agents`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/components/AgentActivityBridge.tsx src/modules/agents/index.ts src/app/App.tsx
git commit -m "feat(agents): bridge poll interval + agent-state socket events into the store"
```

---

## Task 13: TabBar indicator UI

**Files:**
- Modify: `src/modules/tabs/TabBar.tsx` (render the indicator next to the title)

Render per-tab roll-up: `working` → spinner, `blocked` → red dot, `done` → blue dot, `idle` → nothing. Reuse the existing dirty-dot layout (`TabBar.tsx:159-164`). The roll-up reads from `useActivityStore`. We compute the tab's leaf uuids inline.

- [ ] **Step 1: Add a small indicator subcomponent**

In `src/modules/tabs/TabBar.tsx`, add an import and a helper that subscribes to the store. Add near the top imports:

```tsx
import { useActivityStore } from "@/modules/agents/store/activityStore";
import { leafIds } from "@/modules/terminal"; // already pattern-available; or walk tree
import type { PaneNode } from "@/modules/terminal/lib/panes";
import { Loading03Icon } from "@hugeicons/core-free-icons";
```

Add helper + component (below `TabIcon`):

```tsx
function leafUuids(node: PaneNode): string[] {
  if (node.kind === "leaf") return node.uuid ? [node.uuid] : [];
  return node.children.flatMap(leafUuids);
}

function ActivityIndicator({ tab }: { tab: Tab }) {
  // Subscribe so the dot/spinner updates live as states change.
  const state = useActivityStore((s) =>
    tab.kind === "terminal" ? s.rollUpFor(leafUuids(tab.paneTree)) : "idle",
  );
  if (tab.kind !== "terminal" || state === "idle") return null;
  if (state === "working") {
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 animate-spin text-muted-foreground"
        aria-label="Working"
      />
    );
  }
  // blocked -> red, done -> blue. Mirrors the unsaved-changes dot at line ~159.
  const color = state === "blocked" ? "bg-red-500" : "bg-blue-500";
  return (
    <span
      aria-label={state === "blocked" ? "Needs input" : "Done"}
      className={cn("size-1.5 shrink-0 rounded-full", color)}
    />
  );
}
```

> Note: `rollUpFor` is a stable store method but returns a new value only when inputs change; selecting it with a derived computation is fine because the selector returns a primitive (`ActivityState`), so Zustand's default `Object.is` comparison prevents extra re-renders.

- [ ] **Step 2: Render the indicator in both the editing cell and the trigger**

In the trigger's title `<span>` (after the title span, alongside the dirty dot at lines 159-164), add:

```tsx
                    <ActivityIndicator tab={t} />
                    {t.kind === "editor" && t.dirty ? (
```

Also add `<ActivityIndicator tab={t} />` inside the renaming `<div>` cell (after `<TabIcon tab={t} />`, line ~119) so the indicator persists while renaming.

- [ ] **Step 3: Verify it builds + manual visual check via existing tests**

Run: `npx tsc --noEmit && npx vitest run src/modules/tabs`
Expected: clean (tabLabel tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/modules/tabs/TabBar.tsx
git commit -m "feat(tabs): per-tab agent activity indicator (spinner/red/blue dot)"
```

---

## Task 14: No-tmux fallback verification (pure test)

**Files:**
- Modify: `src/modules/agents/store/activityStore.test.ts` (add fallback case)

When tmux is unavailable, `pollForeground` returns `{}`, so `applyPoll({}, now)` touches nothing and the store relies on `recordOutput` (output activity) + hook lines. Verify the store does not crash or wrongly mutate on an empty poll, and that a leaf with recent output but no foreground entry keeps its last state.

- [ ] **Step 1: Add the failing/clarifying test**

Append to `src/modules/agents/store/activityStore.test.ts`:

```ts
describe("no-tmux fallback", () => {
  beforeEach(() => useActivityStore.setState({ leaves: {} }));

  it("empty poll does not change existing leaf states", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "working", 1000);
    s.applyPoll({}, 2000); // tmux unavailable
    expect(useActivityStore.getState().leaves["u1"].state).toBe("working");
  });

  it("hook-only flow works with no foreground polls at all", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "blocked", 1000);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("blocked");
    s.applyHook("u1", "done", 2000);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("done");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/modules/agents/store/activityStore.test.ts`
Expected: PASS (no implementation change needed — `applyPoll` over `{}` is a no-op; if it fails, fix `applyPoll` to early-return when the map is empty).

- [ ] **Step 3: Commit**

```bash
git add src/modules/agents/store/activityStore.test.ts
git commit -m "test(agents): no-tmux fallback keeps hook/output-driven states"
```

---

## Task 15: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run all frontend tests**

Run: `npx vitest run`
Expected: all green, including `activityState`, `activityStore`, `foregroundPoll`, `panes`, existing `tabLabel`.

- [ ] **Step 2: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all green, including `tmux_panes`, `agent_sock`, updated `agent`, existing `shell_init`/`agent_detect`.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: both clean.

- [ ] **Step 4: Manual verification (per spec testing strategy)**

Document results in the PR description:
1. Run a long command (`sleep 30 && echo done`) in a background tab → spinner appears on that tab, clears to nothing/blue when finished.
2. With Claude Code hooks enabled (NotificationBell → "Enable Claude Code alerts"), trigger a permission prompt → red dot on the tab.
3. Let Claude finish → blue dot; click the tab → dot clears.
4. Quit tmux / `brew uninstall tmux` (or hide it) → confirm the heuristic still approximates working from output activity and hooks still drive blocked/done.
5. Split a tab; run an agent in one pane → tab rolls up to the most urgent leaf state.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(agents): verification fixes for activity indicator"
```

---

## Self-Review notes (coverage map)

- **States (working/blocked/done/idle) + rules:** Task 2 (`computeHeuristicState`, `rollUpStates`), Task 3 (`markSeen` done→idle, hook precedence).
- **done→idle on activation:** Task 3 `markSeen` + Task 12 activation effect.
- **Roll-up urgency blocked>working>done>idle:** Task 2 `rollUpStates` + Task 13 `rollUpFor`.
- **Layer 1 heuristic (foreground + output):** Task 4 (lastOutputAt), Task 5/6 (tmux poll), Task 11 (wrapper), Task 12 (interval).
- **Layer 2 hooks (socket):** Task 7/8 (listener + event), Task 9 (env injection), Task 10 (hook command + settings.json snippet via existing installer).
- **Precedence (hook wins, times out):** Task 3 (`HOOK_STALE_MS`).
- **Detect-and-suggest setup:** reuses existing `NotificationBell` flow + `agent_enable_claude_hooks` (Task 10 extends it; no new UI required — the spec's "one-time dismissible notice" already exists in `NotificationBell.tsx`).
- **UI (spinner/red/blue/nothing, dirty-dot pattern):** Task 13.
- **No-tmux fallback:** Task 6 (empty list), Task 11 (`{}`), Task 14 (test).
- **Shared uuid prerequisite:** Task 1 (conditional fallback).
- **Testing strategy (pure unit + Rust parsing):** Tasks 2, 3, 5, 7, 11, 14 (pure), Task 5/7 (Rust parsing), Task 10 (Rust hook merge).

**Type consistency check:** `ActivityState`, `LeafActivity` (two distinct shapes — one in `activityState.ts` for the pure machine, one in `activityStore.ts` for stored entries; intentional, named the same in their own modules), `rollUpFor`, `applyPoll`, `applyHook`, `markSeen`, `dropLeaf`, `recordOutput` consistent across Tasks 3/12/13. `PaneForeground` shape matches between Rust (Task 5) and TS (Task 11). `terax:agent-state` event name + `{pane,state}` payload consistent between Task 8 (Rust emit) and Task 12 (TS listen). `pane_uuid`/`paneUuid` mapping consistent between Task 9 Rust and TS.
