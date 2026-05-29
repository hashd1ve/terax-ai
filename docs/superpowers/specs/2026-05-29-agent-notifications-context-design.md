# Actionable notification bell with conversation context - Design

**Date:** 2026-05-29
**Status:** Implemented on branch `feat/agent-notification-context`
**Related:** builds on `2026-05-27-agent-activity-indicator-design.md` (the per-leaf
state machine and hook socket) and on the usage HUD added in `c5e13b3`
(`agent_usage.rs`, `usageStore`). First of two planned pieces; the second, a
historical cost/token "usage" panel, gets its own spec and reuses the conversation
title introduced here.

## Goal

Turn the notification bell into a "needs from you" surface instead of an activity
log. With several Claude Code panes running, the bell today fills with identical
ambient rows and the user cannot tell the conversations apart. Two problems:

1. **Noise.** The bell lists one "working" row per active session, and pushes a
   fresh "finished" row on every turn (the `Stop` hook fires each turn), so the
   history grows one entry per turn.
2. **No identity.** Rows show only the agent name plus a label; nothing says which
   conversation needs input.

The fix: the bell shows only actionable items (needs-input and errors) plus at most
one finished row per session, and every row carries the conversation title. The
needs-input row also shows the last user prompt, so the user immediately recalls
what the agent is blocked on.

Ambient "working" state is not removed from the product; it stays visible in the
per-pane HUD and the agent dashboard. It just leaves the bell.

## Current behavior (for reference)

`AgentNotificationsBridge.handleSignal` maps `terax:agent-signal` kinds:

- `working` -> `setStatus(working)`. Renders as a live "working" row in the bell
  (one per active session).
- `attention` -> `setStatus(waiting)` + `route(attention)`: pushes a history row
  and toasts (and OS-notifies when unfocused).
- `finished` -> `setStatus(waiting)` + `route(finished)`: pushes a history row every
  turn, OS-notifies when unfocused, never toasts.
- `error` -> pushes a quiet history row, no toast, no OS-notify.
- `exited` -> removes the session.

`NotificationBell` renders all active sessions as `StatusRow` (working/waiting),
then the notification history. Rows render `agent` + a label only. Badge =
waiting count + unread non-attention notifications.

## Design

### 1. Conversation context from the transcript (Rust)

The transcript carries the title and the last user prompt as recurring lines,
rewritten roughly once per turn, so both sit inside the last 64 KB that
`agent_read_usage` already reads:

- `{"type":"ai-title","aiTitle":"...","sessionId":"..."}`
- `{"type":"last-prompt","lastPrompt":"...","leafUuid":"...","sessionId":"..."}`

Extend `UsageInfo` with two best-effort fields, populated from the same tail:

```
title: Option<String>        // last ai-title.aiTitle in the tail
last_prompt: Option<String>  // last last-prompt.lastPrompt in the tail
```

Add pure scanners alongside `parse_last_usage`, each returning the value of the
last matching line so they are unit-testable without the filesystem:

- `parse_last_title(jsonl) -> Option<String>`
- `parse_last_prompt(jsonl) -> Option<String>`

`agent_read_usage` runs all three over the one tail read and folds the results
into `UsageInfo`. Path validation, the 64 KB cap, and the degrade-to-None contract
are unchanged. The TS mirror in `usageStore.ts` gains `title: string | null` and
`lastPrompt: string | null`.

Coupling tradeoff: `agent_read_usage` returns `Option<UsageInfo>`, which is `None`
until a priced assistant turn exists, so the title is unavailable before the first
turn. In practice a needs-input, finished, or error signal only fires after the
agent has produced at least one priced turn, so the title is present whenever a
notification needs it. We accept this rather than widen the command's return shape.

### 2. Notification model (`agentStore`)

Per-kind behavior:

- **working:** no bell row. Live "working" state stays in the HUD and dashboard.
- **needs-input (attention):** a live row derived from sessions in `waiting`
  status, carrying title and last prompt. `waiting` is now set exclusively by
  attention (finished uses `done`), so this row means a genuine block, not a
  finished turn. Still toasts and OS-notifies when the user is not looking. It no
  longer pushes a separate history row, since the live row already represents it
  (removes today's duplication).
- **finished (Stop, every turn):** sets the session status to `done` (distinct
  from `waiting`) and upserts one row per session, keyed by `leafId`. If a finished
  row for that leaf exists, refresh its timestamp and move it to the top instead of
  appending. Because the status is `done`, a finished turn shows only as this quiet
  history row and never as a needs-input row. It is silent (no toast) and does not
  count toward the badge.
- **error:** one history row per occurrence, carrying the title. Silent, as today.

Decision (confirmed): finished previously OS-notified on every turn when the window
was unfocused, the same per-turn noise in OS form. The "actionable only" rule is
that finished stops OS-notifying; only needs-input alerts the user. The bell keeps a
quiet, deduped finished row for reference. A "done while I was away" ping, if ever
wanted, belongs on needs-input, not on every turn boundary.

Badge = waiting (needs-input) count + unread errors. Finished is excluded.

Store shape changes:

- `AgentSession` gains `title?: string` and `lastPrompt?: string`.
- `AgentNotification` gains `title?: string` (a snapshot taken at push time so the
  history keeps the title after the session ends). Last prompt is not snapshotted;
  it only appears on the live needs-input row.
- New `setContext(leafId, { title?, lastPrompt? })` updates the session.
- New `upsertFinished({ leafId, tabId, agent, title })` replaces the per-turn
  `pushNotification` for finished.
- `route()` keeps the toast / OS-notify side effects but stops being the place that
  writes finished and attention history rows.
- `AgentStatus` gains `done` (a finished turn), distinct from `waiting` (genuine
  needs-input from attention). `finished` sets `done`; `attention` sets `waiting`.
  The bell renders only `waiting` sessions as needs-input rows, so a finished agent
  is never shown as needs-input.
- `pickAgentLeafId` (Send to Claude handoff) now prefers any idle session (`waiting`
  or `done`) over one still `working`, which preserves its prior behavior after the
  `waiting`/`done` split.

Context fetch: when an actionable signal fires, the bridge reads the leaf's
`transcriptPath` (already tracked in `activityStore` via `setMeta`), invokes
`agent_read_usage`, and calls `setContext` with the returned title and last prompt.
The fetch is async: the row appears immediately (status flip) and enriches with the
title when the read resolves. This is one bounded IPC call per actionable event,
which is rare, and it also refreshes `usageStore` as a side benefit.

### 3. UI (`NotificationBell.tsx`)

Two sections under the header:

- **Needs input** (sessions in `waiting`): a two-line row. Line one is the headline
  `agent` + conversation title with a primary dot and the "needs input" tag. Line
  two is the last prompt, muted, single line, truncated. Clicking activates the
  pane.
- **History** (finished, one per session, plus errors): single-line rows. Headline
  is `agent` + title; trailing relative time; finished uses the check icon, error
  the destructive dot, as today.

The "N active" count chip in the header stays (it is a compact summary, not a
per-agent row). When agents work quietly and nothing waits, the needs-input section
is empty and the bell shows only history, so it reads as calm rather than busy.

Row label map and time formatting are unchanged. The "Enable Claude Code alerts"
footer is unchanged.

## Data flow

```
terax:agent-signal (attention | finished | error)
  -> handleSignal resolves leafId, reads transcriptPath from activityStore
  -> invoke agent_read_usage(transcriptPath)  // title + lastPrompt + usage
  -> setContext(leafId, { title, lastPrompt }) on the session
  -> attention: setStatus(waiting) + route() for toast/OS-notify only
     finished:  setStatus(done) + upsertFinished({ leafId, title, ... })
     error:     pushNotification({ kind: "error", title, ... })
NotificationBell renders waiting sessions (needs-input, 2 lines) then history.
Badge = waiting count + unread errors.
```

## Architecture notes

Keeps the functional-core / imperative-shell split the project follows. The new
Rust parsers are pure over the transcript text and tested without touching disk.
The store actions are pure reducers. The bridge and component stay thin: the bridge
wires signals to store calls and one IPC read; the component only renders store
state.

## Out of scope (YAGNI)

- The historical cost/token usage panel (the second piece, its own spec).
- Subtitle (last prompt) on finished or error rows; needs-input only.
- Persisting notification history across app restarts.
- Conversation titles for agents other than Claude Code.
- A title-only Rust command; the title rides on the existing usage read.

## Testing strategy

- **Rust unit (pure):** `parse_last_title` and `parse_last_prompt` return the last
  matching value, return None when the line type is absent, and survive a partial
  first line from a mid-line tail seek. Existing `agent_read_usage` tests still pass
  with the added fields.
- **Frontend store (vitest):** finished upsert keeps exactly one row per `leafId`
  and refreshes its timestamp; attention adds no history row; error adds a row with
  its title snapshot; badge counts waiting + unread errors and excludes finished;
  `setContext` updates the session without clobbering unrelated fields.
- **Manual verification:** run two Claude Code panes; trigger a permission prompt in
  one and confirm a single needs-input row with the right title and last prompt;
  let a pane run several turns and confirm one finished row that refreshes rather
  than a row per turn; confirm working panes add no bell rows while staying visible
  in the HUD and dashboard; confirm the badge reflects only needs-input and errors.
