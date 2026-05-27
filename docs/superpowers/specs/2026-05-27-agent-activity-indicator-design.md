# Per-tab agent activity indicator (herdr-style, hybrid detection) — Design

**Date:** 2026-05-27
**Status:** Approved (design), pending implementation plan
**Related:** shares the per-leaf stable `uuid` with
`2026-05-27-session-persistence-design.md`

## Goal

Show, on each terminal tab, whether something is actively running in it — so the
user can tell at a glance when a Claude/agent (or any command) is working, waiting
for their input, or done. Inspired by [herdr](https://github.com/ogulcancelik/herdr),
whose sidebar shows blocked/working/done/idle and whose detection "works by reading
foreground process and terminal output … agents that expose hooks [give] more
robust state reporting."

## States

Four states per terminal pane (leaf):

- 🟡 **working** — a command/agent is actively running.
- 🔴 **blocked** — the agent needs the user's input or approval.
- 🔵 **done** — work finished but the user hasn't viewed the tab yet.
- 🟢 **idle** — sitting at the shell prompt, already seen.

Rules:

- **done → idle** when the user activates/views that tab.
- A tab with split panes **rolls up to its most urgent leaf state**, urgency order:
  `blocked > working > done > idle`.

## Detection (hybrid; hooks override heuristic)

### Layer 1 — heuristic, zero-config

- **Foreground process per pane.** One batched call on an interval (~1.5s):
  `tmux -L terax list-panes -a -F '#{session_name} #{pane_current_command}'`
  (covers background panes cheaply in a single call). A shell command name
  (`zsh`/`bash`/`fish`/`sh`/`pwsh`/`nu`) ⇒ no command running; anything else ⇒ a
  command is active.
- **Output activity.** PTY bytes already arrive in the reader/`deliverPtyBytes`
  path; record `lastOutputAt` per leaf.
- **State machine (heuristic):**
  - foreground = shell ⇒ `idle`, or `done` if it had been running a command and the
    tab is not currently active.
  - foreground ≠ shell **and** output within the last ~2s ⇒ `working`.
  - foreground ≠ shell **and** quiet for > ~10s (tunable) **and** the foreground is a known
    agent (configurable list: `claude`, `codex`, `aider`, …) ⇒ `blocked`. A silent
    non-agent command (e.g. a quiet build) stays `working`, never `blocked`.

### Layer 2 — Claude Code hooks (precise)

- Terax opens a **local listener** (Unix domain socket in its app data dir,
  implemented in Rust so it survives webview reloads) and injects into every PTY:
  `TERAX_PANE=<leaf uuid>` and `TERAX_AGENT_SOCK=<socket path>`.
- A bundled hook script reads those env vars and writes one JSON line
  `{ "pane": "<uuid>", "state": "working|blocked|done" }` to the socket.
- **Event mapping (Claude Code → state):** tool/prompt activity
  (`UserPromptSubmit`, `PreToolUse`) ⇒ working; `Notification` (needs
  permission/input) ⇒ blocked; `Stop`/`SubagentStop` ⇒ done.
- **Detect-and-suggest setup.** The heuristic already works with no setup. If Terax
  sees Claude Code in use without the hooks configured, it shows a one-time,
  dismissible notice offering to install them (the script + a `~/.claude/settings.json`
  snippet ship with Terax). Terax never edits the user's config without consent.
- **Precedence.** When a hook has reported a state recently, it wins over the
  heuristic; the heuristic fills the gaps and times out stale hook states.

### No-tmux fallback

- Foreground-process detection is best-effort (or unavailable); detection relies
  primarily on output activity. Hooks (if installed) still work, since they don't
  depend on tmux.

## UI (TabBar)

- **working:** a small animated spinner in the tab's leading icon slot.
- **blocked:** a red dot.
- **done:** a blue dot.
- **idle:** nothing (no clutter), matching the restraint of the existing
  unsaved-changes dot.
- Indicator sits next to the title, reusing the existing tab-icon / dirty-dot layout
  pattern in `TabBar.tsx`.

## Architecture

- **State store (frontend):** a map keyed by leaf `uuid` holding
  `{ state, lastOutputAt, source: "hook" | "heuristic", seen }`. The tab bar reads
  it and computes per-tab roll-up.
- **Foreground polling (frontend → Rust):** a new command returns the batched
  `list-panes` output; the frontend updates the map and runs the state machine.
- **Agent socket (Rust):** listener created at app start, independent of the
  webview; parses incoming JSON lines and emits a Tauri event
  `agent-state { pane, state }` to the frontend.
- **Env injection (Rust, pty spawn):** `TERAX_PANE` / `TERAX_AGENT_SOCK` added to
  the child environment when spawning each pane.

## Shared prerequisite

The **stable per-leaf `uuid`** (added to `PaneNode` in `terminal/lib/panes.ts`) is
required by both this feature and session persistence. Whichever ships first
introduces it; the other reuses it.

## Out of scope (YAGNI)

- OS notifications (could later hook into the existing `NotificationBell`).
- Semantic state for agents other than Claude Code (beyond the heuristic).
- Workspace-level roll-up (herdr's sidebar grouping) — Terax has a single tab bar.

## Testing strategy

- **Unit (pure):** the state machine (foreground + output-activity + hook input →
  state) across all transitions; per-tab roll-up urgency ordering; known-agent
  classification. Pure-logic tests in the style of `tabLabel.test.ts`.
- **Rust:** parsing of the batched `list-panes` output; agent-socket JSON line
  parsing (valid, malformed, partial); env-var injection.
- **Manual verification:** run a long command in a background tab → confirm spinner;
  trigger a Claude Code permission prompt → confirm red dot; let it finish →
  confirm blue dot, then view the tab → confirm it clears; with hooks uninstalled,
  confirm the heuristic still approximates the states.
