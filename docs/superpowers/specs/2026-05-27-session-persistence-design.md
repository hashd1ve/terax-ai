# Session persistence (herdr-style, tmux-per-pane) — Design

**Date:** 2026-05-27
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/session-persistence`

## Goal

Make Terax remember and resume its workspace. When the user closes the app (or
reloads the dev webview) and reopens it, everything they had comes back: the same
terminal tabs and split panels, the same editor/preview/git tabs, and — crucially
— the terminal **processes keep running**. A `npm run dev`, a `vim`, an SSH
session, or a long-running agent should still be alive on reopen.

This mirrors [herdr](https://github.com/ogulcancelik/herdr): *"close your terminal,
close your laptop; your agents keep running."*

## Why tmux (chosen approach)

Today every terminal pane is a PTY owned by a `HashMap<u32, Arc<Session>>` inside
the Tauri app's Rust process (`src-tauri/src/modules/pty/`). When the app exits,
the OS kills those shells. There is no on-disk state. (See the architecture map in
the project's exploration notes; key refs: `pty/mod.rs`, `pty/session.rs`,
`tabs/lib/useTabs.ts`, `terminal/lib/panes.ts`.)

To get real process survival we need the shells to live in a process that outlives
the app. Building a custom daemon (the literal herdr architecture) means
re-architecting the whole PTY backend into a client/server split with its own IPC
protocol, lifecycle, and output buffering — weeks of work and real risk.

Instead, **each pane's shell runs inside an isolated tmux session.** tmux is a
battle-tested multiplexer that already solves process survival, scrollback, and
redraw-on-reattach. Terax's render/resize/write plumbing is unchanged: it still
drives a normal PTY whose contents happen to be a tmux client. We use **one tmux
session per Terax pane (leaf)** — we do *not* use tmux's own splitting; Terax keeps
owning the layout.

Trade-off accepted: tmux must be installed (not shipped on macOS by default). If
absent, Terax degrades gracefully (see "tmux not available").

## Scope

In scope:

- Restore the full workspace on launch: terminal tabs + split panels, editor tabs,
  preview tabs, git graph/history tabs, the active tab, cwd, and custom tab titles.
- Terminal panes reattach to **live** tmux sessions (process survival) across full
  app restart and dev webview reload.
- Restore terminal scrollback text so the pane looks like it did.
- Non-terminal tabs reopen by descriptor (same file path / URL / view).

Out of scope (YAGNI for now):

- Multiple windows; cross-machine sync.
- Process survival on Windows.
- Preserving unsaved editor buffer contents (editors reopen the file from disk).
- A custom daemon (explicitly rejected in favor of tmux).

## Components

### 1. tmux-backed PTY (Rust, `src-tauri/src/modules/pty/`)

- tmux always runs on a **dedicated socket**: `tmux -L terax …`. This isolates
  Terax's sessions from the user's own tmux server and config.
- A **minimal injected config** is passed with `-f <terax tmux.conf>`:
  - `set -g status off`
  - `set -g escape-time 0`
  - prefix disabled (`set -g prefix None` / `unbind C-b`)
  - `set -g mouse off` (xterm/Terax owns mouse)
  - `set -g history-limit <terminalScrollback pref>`
  - `set -g default-terminal "tmux-256color"`
  - `set -g allow-passthrough on`
  - `set -g destroy-unattached off` (sessions must survive detach)
- **One session per leaf**, named `terax_<uuid>` (see stable IDs below).
- **Spawn / reattach (same command):**
  `tmux -L terax new-session -A -s terax_<uuid> -x <cols> -y <rows> -c <cwd>`
  `-A` = attach-or-create, so creation and reattach use one code path.
- New Tauri command `pty_kill_persistent(name)` →
  `tmux -L terax kill-session -t <name>`, called when the user **explicitly**
  closes a tab/panel (so only sessions open at quit time survive).
- **Startup GC:** `tmux -L terax ls` and kill any `terax_*` session that is not
  referenced by the persisted workspace (prevents orphan accumulation).
- The existing `pty_close_all` (orphan reaper on webview load) now only **detaches**
  tmux clients — the tmux sessions themselves persist. Its role narrows to cleaning
  up the previous webview's PTY client handles.

### 2. Stable session identity (frontend, `terminal/lib/panes.ts`)

- Leaf IDs today are monotonic numbers reset every session — not stable across
  restarts. Add a **stable `uuid` field to each leaf `PaneNode`**, generated once on
  leaf creation and persisted. This `uuid` is the 1:1 key to the tmux session name
  (`terax_<uuid>`). This is the only change to the pane data structure.

### 3. On-disk persistence (`terax-workspace.json`)

- A new store using the existing `@tauri-apps/plugin-store` mechanism (same as
  `terax-settings.json` / `terax-ai-sessions.json`).
- Contents:
  - tab/panel tree (the full `tabs` array, serializable form)
  - active tab id
  - per terminal leaf: `uuid`, last-known `cwd`
  - non-terminal tab descriptors: editor → file path; preview → URL; git → view type
- Written **debounced** on workspace changes (tab open/close, split, rename, active
  tab change) **and** on **window close** via a new `onCloseRequested` handler
  (none exists today).

### 4. Restore on launch (`src/main.tsx`, `src/app/App.tsx`)

- Replace "always create a fresh tab" with: load `terax-workspace.json`,
  reconstruct the tab tree, set the active tab.
- For each terminal leaf: run the `new-session -A` command (reattaches if alive,
  creates if not).
- **Scrollback restore:** on reattach, `tmux -L terax capture-pane -p -S -<N>`
  grabs the last N lines of history (N = the `terminalScrollback` preference,
  capped to tmux's `history-limit`) and pre-loads them into the xterm buffer before
  live attach, so the user sees prior output without entering tmux copy-mode.
- Non-terminal tabs reopen from their descriptors.
- If no workspace file exists (first run), behave exactly as today (one fresh tab).

## Data flow

1. **Steady state:** workspace changes → debounced write to `terax-workspace.json`.
   Each terminal pane's shell lives in its `terax_<uuid>` tmux session.
2. **Close app / reload webview:** `onCloseRequested` flushes the workspace file;
   PTY clients detach; tmux sessions stay alive.
3. **Reopen:** load workspace → rebuild tabs → each terminal leaf `new-session -A`
   (reattach) → `capture-pane` preload → live. Startup GC kills orphan `terax_*`
   sessions. Non-terminal tabs reopen by descriptor.

## tmux not available (fallback + notice)

- On startup, detect tmux by running `tmux -V` (presence/version check).
- If absent (or on Windows): terminals spawn directly as today (no persistence),
  and the workspace file still restores **layout only** for what it can. Show a
  one-time, dismissible notice suggesting `brew install tmux` to enable full
  persistence.

## Default decisions (locked unless changed)

- **Private / incognito terminals do NOT persist** (ephemeral by design) — they
  spawn directly, never get a tmux session, and are excluded from the workspace
  file.
- **Unsaved editor changes are not preserved** — the file reopens from disk.
- **cwd** comes from tmux (`#{pane_current_path}`), which is more reliable through
  tmux than the current OSC-based detection.
- **Platform:** persistence on macOS/Linux; Windows falls back to no persistence.

## Risks & mitigations

- **OSC passthrough through tmux** (cwd/title escape sequences may behave
  differently): mitigated by using tmux-native data (`pane_current_path`) and
  `allow-passthrough on`.
- **Orphan tmux sessions** accumulating: mitigated by startup GC + explicit
  kill-on-close.
- **Scrollback feels off** (tmux holds history, xterm shows current screen):
  mitigated by `capture-pane` preload into xterm on reattach.
- **Resize mismatch** (tmux constrains to smallest client): one client per session,
  so not an issue; resize flows through existing `pty_resize`.

## Testing strategy

- **Unit (pure):** workspace serialize/deserialize round-trip; pane-tree with
  stable `uuid`s; tmux session-name mapping; GC selection (which `terax_*` to kill).
  These follow the existing pure-logic test style (e.g. `tabLabel.test.ts`).
- **Rust:** tmux command construction (args for new-session / kill / capture / ls)
  unit-tested without spawning tmux; a guarded integration test that spawns a real
  tmux on the `terax` socket when available (skipped if not).
- **Manual verification:** open several panes running long commands → quit Terax →
  reopen → confirm processes still running and scrollback restored; close one tab →
  confirm its tmux session is gone; uninstall/hide tmux → confirm graceful fallback.
