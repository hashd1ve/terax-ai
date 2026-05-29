# Actionable notification bell with conversation context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Code notification bell show only actionable items (needs-input and errors) plus one deduped "finished" row per session, each labeled with the conversation title, and the last user prompt on needs-input rows.

**Architecture:** The transcript already carries `ai-title` and `last-prompt` lines inside the 64 KB tail that `agent_read_usage` reads, so the Rust command grows two best-effort fields. The frontend stores those on the per-session record, the bell renders only waiting sessions plus finished/error history, and the bridge fetches context lazily by mapping `leafId` to the leaf `uuid` (and thus `transcriptPath`) the same way the dashboard does.

**Tech Stack:** Rust (Tauri command, serde_json), TypeScript, React 19, Zustand stores, vitest, Tailwind.

**Conventions (from TERAX.md):** no em-dash anywhere (code, comments, commits, docs); no emojis; comments explain why not what, default to none; imports use `@/...`; pnpm only. Verify with `pnpm exec tsc --noEmit`, `pnpm test`, and in `src-tauri`: `cargo clippy` and `cargo test --locked`.

**Branching:** the repo is on `main`. Before the first commit, create a feature branch (e.g. `git switch -c feat/agent-notification-context`). Do not commit to `main`.

---

## File structure

- **`src-tauri/src/modules/agent_usage.rs`** (modify): add `title` and `last_prompt` to `UsageInfo`; add pure `parse_last_title` / `parse_last_prompt`; fold both into `agent_read_usage`. Owns all transcript parsing.
- **`src/modules/agents/store/usageStore.ts`** (modify): mirror the two new fields on the TS `UsageInfo` type.
- **`src/modules/agents/lib/types.ts`** (modify): add `title?` / `lastPrompt?` to `AgentSession`; add `title?` to `AgentNotification`.
- **`src/modules/agents/store/agentStore.ts`** (modify): add `setContext` and `upsertFinished` actions; let `pushNotification` carry `title`.
- **`src/modules/agents/lib/bell.ts`** (create): pure `bellBadgeCount` helper, unit-tested.
- **`src/modules/agents/lib/bell.test.ts`** (create): tests for `bellBadgeCount`.
- **`src/modules/agents/store/agentStore.test.ts`** (create): tests for `upsertFinished`, `setContext`, `pushNotification` title.
- **`src/modules/agents/lib/route.ts`** (modify): make it alert-only (toast / OS-notify); stop writing history rows.
- **`src/modules/agents/components/AgentNotificationsBridge.tsx`** (modify): new per-kind handling, lazy context fetch, `leafId` to `transcriptPath` mapping.
- **`src/modules/agents/components/NotificationBell.tsx`** (modify): render only waiting sessions (two-line, with title and last prompt) plus finished/error history (with title); new badge from `bellBadgeCount`.

---

## Task 1: Backend extracts conversation title and last prompt

**Files:**
- Modify: `src-tauri/src/modules/agent_usage.rs`
- Test: `src-tauri/src/modules/agent_usage.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `mod tests { ... }` block in `src-tauri/src/modules/agent_usage.rs`:

```rust
    #[test]
    fn last_title_wins_and_absent_is_none() {
        let jsonl = r#"{"type":"ai-title","aiTitle":"First title","sessionId":"s"}
{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"ai-title","aiTitle":"Renamed title","sessionId":"s"}"#;
        assert_eq!(parse_last_title(jsonl).as_deref(), Some("Renamed title"));

        let no_title = r#"{"type":"user","message":{"role":"user","content":"hi"}}"#;
        assert_eq!(parse_last_title(no_title), None);
        assert_eq!(parse_last_title(""), None);
        assert_eq!(parse_last_title("not json\n{ broken"), None);
    }

    #[test]
    fn last_prompt_wins_and_absent_is_none() {
        let jsonl = r#"{"type":"last-prompt","lastPrompt":"do A","leafUuid":"u","sessionId":"s"}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"output_tokens":1}}}
{"type":"last-prompt","lastPrompt":"now do B","leafUuid":"u","sessionId":"s"}"#;
        assert_eq!(parse_last_prompt(jsonl).as_deref(), Some("now do B"));

        let none = r#"{"type":"ai-title","aiTitle":"t","sessionId":"s"}"#;
        assert_eq!(parse_last_prompt(none), None);
    }

    #[test]
    fn parse_last_usage_defaults_context_fields_to_none() {
        let line = r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"output_tokens":1}}}"#;
        let info = parse_last_usage(line).unwrap();
        assert_eq!(info.title, None);
        assert_eq!(info.last_prompt, None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_usage`
Expected: FAIL to compile (`parse_last_title`, `parse_last_prompt`, and the `title` / `last_prompt` fields do not exist yet).

- [ ] **Step 3: Add the two fields to `UsageInfo`**

In `src-tauri/src/modules/agent_usage.rs`, add to the `UsageInfo` struct, after `cost_usd_est`:

```rust
    /// The agent's conversation title (`ai-title` line), or None before one is
    /// generated. Best-effort like every other field here.
    pub title: Option<String>,
    /// The user's most recent prompt (`last-prompt` line), or None.
    pub last_prompt: Option<String>,
```

- [ ] **Step 4: Default the new fields in `usage_from_line`**

In `usage_from_line`, the `Some(UsageInfo { ... })` constructor builds from a single assistant line, which never carries the title. Add the defaults so it still compiles:

```rust
    Some(UsageInfo {
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        context_tokens,
        context_window,
        context_pct,
        cost_usd_est,
        title: None,
        last_prompt: None,
    })
```

- [ ] **Step 5: Add the pure parsers**

Add these functions next to `parse_last_usage` in `src-tauri/src/modules/agent_usage.rs`:

```rust
fn title_from_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "ai-title" {
        return None;
    }
    value.get("aiTitle")?.as_str().map(str::to_string)
}

/// Title of the LAST `ai-title` line in the text. Pure so the recency rule is
/// testable without the filesystem. The title is rewritten roughly once per
/// turn, so the tail almost always carries a recent one.
pub fn parse_last_title(jsonl: &str) -> Option<String> {
    jsonl.lines().rev().find_map(|line| title_from_line(line.trim()))
}

fn prompt_from_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "last-prompt" {
        return None;
    }
    value.get("lastPrompt")?.as_str().map(str::to_string)
}

/// The LAST user prompt (`last-prompt` line) in the text, same recency rule.
pub fn parse_last_prompt(jsonl: &str) -> Option<String> {
    jsonl.lines().rev().find_map(|line| prompt_from_line(line.trim()))
}
```

- [ ] **Step 6: Fold title and prompt into `agent_read_usage`**

Replace the `match read_tail(...)` block in `agent_read_usage` with:

```rust
    match read_tail(&path, TAIL_BYTES) {
        Ok(tail) => Ok(parse_last_usage(&tail).map(|mut usage| {
            usage.title = parse_last_title(&tail);
            usage.last_prompt = parse_last_prompt(&tail);
            usage
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read transcript: {e}")),
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_usage`
Expected: PASS (all existing `agent_usage` tests plus the three new ones).

- [ ] **Step 8: Lint and commit**

Run: `cd src-tauri && cargo clippy`
Expected: no warnings on `agent_usage.rs`.

```bash
git add src-tauri/src/modules/agent_usage.rs
git commit -m "feat(agents): extract conversation title and last prompt from transcript

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Mirror the new fields on the frontend types

**Files:**
- Modify: `src/modules/agents/store/usageStore.ts:5-15`
- Modify: `src/modules/agents/lib/types.ts:19-38`

- [ ] **Step 1: Add the fields to the TS `UsageInfo` mirror**

In `src/modules/agents/store/usageStore.ts`, add to the `UsageInfo` type after `costUsdEst`:

```typescript
  title: string | null;
  lastPrompt: string | null;
```

- [ ] **Step 2: Extend `AgentSession` and `AgentNotification`**

In `src/modules/agents/lib/types.ts`, add to `AgentSession` (after `attentionSince`):

```typescript
  /** Conversation title (ai-title), resolved lazily from the transcript. */
  title?: string;
  /** The user's last prompt, shown only on the live needs-input row. */
  lastPrompt?: string;
```

And add to `AgentNotification` (after `agent`):

```typescript
  /** Conversation title snapshot, kept so history rows survive the session. */
  title?: string;
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (these are additive optional fields; no call sites break).

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/store/usageStore.ts src/modules/agents/lib/types.ts
git commit -m "feat(agents): add title and lastPrompt to usage and session types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Store actions for context and deduped finished

**Files:**
- Modify: `src/modules/agents/store/agentStore.ts`
- Test: `src/modules/agents/store/agentStore.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/modules/agents/store/agentStore.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "./agentStore";

function reset() {
  useAgentStore.setState({ sessions: {}, notifications: [] });
}

describe("agentStore", () => {
  beforeEach(reset);

  it("upsertFinished keeps one row per leaf and refreshes it to the top", () => {
    const s = useAgentStore.getState();
    s.upsertFinished({ leafId: 1, tabId: 10, agent: "claude", title: "Task A" });
    s.upsertFinished({ leafId: 2, tabId: 11, agent: "claude", title: "Task B" });
    s.upsertFinished({ leafId: 1, tabId: 10, agent: "claude", title: "Task A v2" });

    const notes = useAgentStore.getState().notifications;
    const finishedForLeaf1 = notes.filter(
      (n) => n.kind === "finished" && n.leafId === 1,
    );
    expect(finishedForLeaf1).toHaveLength(1);
    expect(finishedForLeaf1[0].title).toBe("Task A v2");
    // Most recent upsert moves to the front.
    expect(notes[0].leafId).toBe(1);
  });

  it("setContext merges fields onto the session without clobbering", () => {
    const s = useAgentStore.getState();
    s.start(1, 10, "claude");
    s.setContext(1, { title: "My title" });
    s.setContext(1, { lastPrompt: "do the thing" });

    const session = useAgentStore.getState().sessions[1];
    expect(session.title).toBe("My title");
    expect(session.lastPrompt).toBe("do the thing");
  });

  it("setContext on a missing session is a no-op", () => {
    useAgentStore.getState().setContext(99, { title: "x" });
    expect(useAgentStore.getState().sessions[99]).toBeUndefined();
  });

  it("pushNotification carries the title snapshot", () => {
    useAgentStore.getState().pushNotification({
      source: "terminal",
      leafId: 3,
      tabId: 12,
      agent: "claude",
      kind: "error",
      title: "Broken build",
    });
    expect(useAgentStore.getState().notifications[0].title).toBe("Broken build");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- agentStore`
Expected: FAIL (`upsertFinished` and `setContext` are not defined; `pushNotification` does not accept `title`).

- [ ] **Step 3: Declare the new actions in the store type**

In `src/modules/agents/store/agentStore.ts`, add to `AgentStoreState` (after `setStatus`):

```typescript
  setContext: (leafId: number, ctx: { title?: string | null; lastPrompt?: string | null }) => void;
  upsertFinished: (n: { leafId: number; tabId: number; agent: string; title?: string }) => void;
```

- [ ] **Step 4: Implement `setContext`**

Add this action to the store object (after `setStatus`). It merges only truthy fields, mirroring `activityStore.setMeta`, so a null title from the backend never wipes a known one:

```typescript
  setContext: (leafId, ctx) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev) return s;
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            ...(ctx.title ? { title: ctx.title } : {}),
            ...(ctx.lastPrompt ? { lastPrompt: ctx.lastPrompt } : {}),
          },
        },
      };
    }),
```

- [ ] **Step 5: Implement `upsertFinished`**

Add this action to the store object. It replaces any existing finished row for the leaf and moves the row to the front:

```typescript
  upsertFinished: ({ leafId, tabId, agent, title }) =>
    set((s) => {
      const now = Date.now();
      const idx = s.notifications.findIndex(
        (n) => n.kind === "finished" && n.leafId === leafId,
      );
      const rest =
        idx >= 0 ? s.notifications.filter((_, i) => i !== idx) : s.notifications;
      const row =
        idx >= 0
          ? { ...s.notifications[idx], at: now, read: false, title, tabId, agent }
          : {
              id: `n${++notifSeq}`,
              source: "terminal" as const,
              leafId,
              tabId,
              agent,
              kind: "finished" as const,
              title,
              at: now,
              read: false,
            };
      return { notifications: [row, ...rest].slice(0, MAX_NOTIFICATIONS) };
    }),
```

- [ ] **Step 6: Let `pushNotification` carry `title`**

`pushNotification` already spreads its argument, so once `AgentNotification.title` exists (Task 2) the title flows through. Confirm the existing implementation spreads `n`:

```typescript
  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),
```

No change is needed if it already looks like this. The `Omit<AgentNotification, "id" | "at" | "read">` parameter type now includes the optional `title`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test -- agentStore`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/modules/agents/store/agentStore.ts src/modules/agents/store/agentStore.test.ts
git commit -m "feat(agents): add setContext and deduped upsertFinished store actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Pure badge helper

**Files:**
- Create: `src/modules/agents/lib/bell.ts`
- Test: `src/modules/agents/lib/bell.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/modules/agents/lib/bell.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { bellBadgeCount } from "./bell";
import type { AgentNotification, AgentSession } from "./types";

function session(leafId: number, status: AgentSession["status"]): AgentSession {
  return {
    leafId,
    tabId: leafId,
    agent: "claude",
    status,
    startedAt: 0,
    lastActivityAt: 0,
    attentionSince: null,
  };
}

function note(kind: AgentNotification["kind"], read: boolean): AgentNotification {
  return { id: `n${kind}${read}`, source: "terminal", leafId: 1, tabId: 1, agent: "claude", kind, at: 0, read };
}

describe("bellBadgeCount", () => {
  it("counts waiting sessions plus unread errors, ignoring finished", () => {
    const sessions = [session(1, "waiting"), session(2, "working"), session(3, "waiting")];
    const notifications = [
      note("error", false),
      note("error", true),
      note("finished", false),
    ];
    expect(bellBadgeCount(sessions, notifications)).toBe(3); // 2 waiting + 1 unread error
  });

  it("is zero when nothing needs attention", () => {
    expect(bellBadgeCount([session(1, "working")], [note("finished", false)])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- bell`
Expected: FAIL (`./bell` module not found).

- [ ] **Step 3: Implement the helper**

Create `src/modules/agents/lib/bell.ts`:

```typescript
import type { AgentNotification, AgentSession } from "./types";

/** Badge count for the bell: items that actually need the user. Waiting
 *  sessions (needs input) plus unread errors; finished is informational and
 *  never badges. */
export function bellBadgeCount(
  sessions: AgentSession[],
  notifications: AgentNotification[],
): number {
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const unreadErrors = notifications.filter(
    (n) => !n.read && n.kind === "error",
  ).length;
  return waiting + unreadErrors;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- bell`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/lib/bell.ts src/modules/agents/lib/bell.test.ts
git commit -m "feat(agents): add pure bellBadgeCount helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Alert-only route and rewritten bridge

**Files:**
- Modify: `src/modules/agents/lib/route.ts`
- Modify: `src/modules/agents/components/AgentNotificationsBridge.tsx`

- [ ] **Step 1: Make `route.ts` alert-only**

Replace the entire contents of `src/modules/agents/lib/route.ts` with the following. It drops the `pushNotification` write (history is now owned by the bridge via the store) and keeps only the toast / OS-notify side effects, still gated by the preference and by focus-and-visible:

```typescript
import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { osNotify } from "./notify";

type AlertArgs = {
  agent: string;
  title: string;
  body?: string;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  onActivate: () => void;
};

/** Toast / OS-notify for an attention (needs-input) event. The bell history is
 *  written separately by the bridge; this function only alerts. */
export function alertAgentAttention({
  agent,
  title,
  body,
  focused,
  visible,
  allowToast,
  onActivate,
}: AlertArgs): void {
  if (!usePreferencesStore.getState().agentNotifications) return;
  if (focused && visible) return;
  if (!focused) {
    void osNotify(title, body ?? agent);
    return;
  }
  if (allowToast) {
    showAgentToast({ agent, title, body, onActivate });
  }
}
```

- [ ] **Step 2: Rewrite the bridge**

Replace the entire contents of `src/modules/agents/components/AgentNotificationsBridge.tsx` with:

```typescript
import type { Tab } from "@/modules/tabs";
import { findLeafUuid } from "@/modules/terminal/lib/panes";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { alertAgentAttention } from "../lib/route";
import type { AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useActivityStore } from "../store/activityStore";
import { useAgentStore } from "../store/agentStore";
import type { UsageInfo } from "../store/usageStore";

type Activate = (tabId: number, leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): { tabId: number; title: string } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, title: t.title };
    }
  }
  return null;
}

/** The transcript path lives in the activity store keyed by the leaf uuid; map
 *  leafId -> uuid the same way the dashboard does. */
function transcriptPathForLeaf(tabs: Tab[], leafId: number): string | null {
  for (const t of tabs) {
    if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) continue;
    const uuid = findLeafUuid(t.paneTree, leafId);
    if (!uuid) return null;
    return useActivityStore.getState().leaves[uuid]?.transcriptPath ?? null;
  }
  return null;
}

/** Resolve and cache the conversation title (and last prompt) on the session.
 *  Skips the read when a title is already cached unless forceFresh is set
 *  (needs-input wants the live last prompt every time). One bounded fs read. */
async function ensureContext(
  leafId: number,
  ctx: Ctx,
  forceFresh: boolean,
): Promise<void> {
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  if (!session) return;
  if (!forceFresh && session.title) return;
  const transcriptPath = transcriptPathForLeaf(ctx.tabs, leafId);
  if (!transcriptPath) return;
  try {
    const info = await invoke<UsageInfo | null>("agent_read_usage", {
      transcriptPath,
    });
    if (info) {
      store.setContext(leafId, { title: info.title, lastPrompt: info.lastPrompt });
    }
  } catch {
    // Rejected path / unreadable / drift: keep whatever context we had.
  }
}

async function onAttention(leafId: number, ctx: Ctx): Promise<void> {
  await ensureContext(leafId, ctx, true);
  const session = useAgentStore.getState().sessions[leafId];
  if (!session) return;
  const info = tabInfo(ctx.tabs, leafId);
  alertAgentAttention({
    agent: session.agent,
    title: `${session.agent} needs your input`,
    body: session.title ?? info?.title,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    allowToast: true,
    onActivate: () => ctx.onActivate(session.tabId, session.leafId),
  });
}

async function onFinished(leafId: number, ctx: Ctx): Promise<void> {
  if (!usePreferencesStore.getState().agentNotifications) return;
  await ensureContext(leafId, ctx, false);
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  const info = tabInfo(ctx.tabs, leafId);
  store.upsertFinished({
    leafId,
    tabId: session?.tabId ?? info?.tabId ?? 0,
    agent: session?.agent ?? "claude",
    title: session?.title,
  });
}

async function onError(leafId: number, ctx: Ctx): Promise<void> {
  await ensureContext(leafId, ctx, false);
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  const info = tabInfo(ctx.tabs, leafId);
  store.pushNotification({
    source: "terminal",
    agent: session?.agent ?? "claude",
    kind: "error",
    tabId: info?.tabId ?? session?.tabId ?? 0,
    leafId,
    title: session?.title,
  });
}

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      store.start(leafId, info.tabId, sig.agent ?? "agent");
      return;
    }
    case "working":
      store.setStatus(leafId, "working");
      return;
    case "attention":
      store.setStatus(leafId, "waiting");
      void onAttention(leafId, ctx);
      return;
    case "finished":
      store.setStatus(leafId, "waiting");
      void onFinished(leafId, ctx);
      return;
    case "error":
      void onError(leafId, ctx);
      return;
    case "exited":
      store.finish(leafId);
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate });
  ctxRef.current = { tabs, activeId, focused, onActivate };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("terax:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
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

  return null;
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm exec tsc --noEmit`
Expected: PASS. If `findLeafUuid` is not exported from `@/modules/terminal`, import it from `@/modules/terminal/lib/panes` as shown above (it is exported there per `panes.ts`).

- [ ] **Step 4: Run the full frontend test suite**

Run: `pnpm test`
Expected: PASS. Note: `route.ts` no longer exports `routeAgentNotification`; confirm no other file imports it.

Run: `grep -rn "routeAgentNotification" src` and expect no matches. If any remain, they are stale and must be updated to `alertAgentAttention` or removed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/lib/route.ts src/modules/agents/components/AgentNotificationsBridge.tsx
git commit -m "feat(agents): route needs-input as alert-only, dedupe finished, drop working from bell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Bell UI shows needs-input with context and clean history

**Files:**
- Modify: `src/modules/agents/components/NotificationBell.tsx`

- [ ] **Step 1: Replace `StatusRow` with a needs-input row**

In `src/modules/agents/components/NotificationBell.tsx`, replace the `StatusRow` component with a two-line needs-input row that shows the title and last prompt. The row only ever renders for `waiting` sessions, so the "working" label is gone:

```typescript
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
```

- [ ] **Step 2: Add the title to history rows**

Update `NotificationRow` so its headline includes the title snapshot:

```typescript
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {n.agent}
        {n.title ? <span className="text-muted-foreground"> · {n.title}</span> : null}{" "}
        <span className="text-muted-foreground">{NOTIF_LABEL[n.kind]}</span>
      </span>
```

- [ ] **Step 3: Update imports and the component body**

At the top of the file, add `AgentSession` to the type import and import the badge helper:

```typescript
import type { AgentNotification, AgentSession } from "../lib/types";
import { bellBadgeCount } from "../lib/bell";
```

In the `NotificationBell` function body, replace the `active` / `activeCount` / `waitingCount` / `unreadDone` / `badge` block with:

```typescript
  const active = useMemo(() => Object.values(sessions), [sessions]);
  const activeCount = active.length;
  const needsInput = useMemo(
    () => active.filter((s) => s.status === "waiting"),
    [active],
  );
  const badge = bellBadgeCount(active, notifications);
```

- [ ] **Step 4: Render only needs-input sessions, then history**

Replace the `active.map(...)` block (the one rendering `StatusRow`) with the needs-input list, and keep the separator and notifications list:

```typescript
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
```

Update the `empty` guard so the panel is empty only when there is nothing to show:

```typescript
  const empty = needsInput.length === 0 && notifications.length === 0;
```

The header "N active" chip keeps using `activeCount` (all active sessions, working included) so the user still sees how many agents run, without per-agent rows.

- [ ] **Step 5: Remove now-unused code**

Delete the `AgentStatus` import if it is no longer referenced, and remove the old `StatusRow` definition (replaced by `NeedsInputRow`). Confirm `Loading03Icon` is still used by the footer spinner; keep it.

- [ ] **Step 6: Verify type-check and tests**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/agents/components/NotificationBell.tsx
git commit -m "feat(agents): bell shows needs-input with conversation context, clean history

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Frontend gates**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: both PASS.

- [ ] **Step 2: Rust gates**

Run: `cd src-tauri && cargo clippy && cargo test --locked`
Expected: no clippy warnings; all tests PASS.

- [ ] **Step 3: Manual verification (pnpm tauri dev)**

Note: saving files during `pnpm tauri dev` reloads the webview, which looks like a restart. Launch, then verify without editing files:

- Run two Claude Code panes. Confirm neither adds a "working" row to the bell while running; the header still shows the active count.
- Trigger a permission prompt (or a question) in one pane. Confirm exactly one needs-input row appears, with the conversation title and the last prompt beneath it, and that focusing the pane clears it.
- Let a pane run several turns. Confirm the bell shows a single "finished" row for that session that refreshes its timestamp, not one row per turn.
- Cause a tool failure. Confirm one "failed" row appears with the conversation title.
- Confirm the badge reflects only needs-input plus unread errors (finished does not bump it).
- Confirm the per-pane HUD and the agent dashboard still show working state and context/cost (unchanged).

- [ ] **Step 4: Final review of the diff**

Run: `git diff main --stat`
Confirm only the files listed in this plan changed.

---

## Self-review notes

- **Spec coverage:** title and lastPrompt extraction (Task 1, 2); working removed from bell (Task 6); finished deduped per session (Task 3, 5, 6); needs-input as live row with title and subtitle (Task 5, 6); attention no longer writes a history row and finished no longer OS-notifies (Task 5, route is alert-only and only attention calls it); badge = needs-input + errors (Task 4, 6); error row carries title (Task 5, 6). All covered.
- **Type consistency:** `setContext`, `upsertFinished`, `bellBadgeCount`, `alertAgentAttention`, `transcriptPathForLeaf`, `ensureContext` are named identically in their definitions and call sites. `UsageInfo.title` / `.lastPrompt` (TS) mirror `title` / `last_prompt` (Rust serde camelCase).
- **Known tradeoff (from spec):** `agent_read_usage` returns null until a priced assistant turn exists, so the title is unavailable before the first turn; acceptable because actionable signals follow at least one turn.
