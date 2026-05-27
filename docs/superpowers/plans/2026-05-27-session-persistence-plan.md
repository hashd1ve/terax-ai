# Session Persistence (tmux-per-pane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Terax remember and resume its full workspace — tabs, split panels, non-terminal tabs, and live terminal processes — across full app restart and dev webview reload, by running each terminal pane's shell inside an isolated tmux session.

**Architecture:** Each terminal pane (leaf) gets a stable `uuid`. Its shell is launched via `tmux -L terax new-session -A -s terax_<uuid>` on a dedicated socket with an injected minimal config, so the process survives the app exiting. A debounced `@tauri-apps/plugin-store` file (`terax-workspace.json`) persists the tab tree + active tab + leaf uuids/cwds + non-terminal descriptors, flushed on workspace change and on window close. On launch, the workspace is reconstructed; terminal leaves reattach to (or recreate) their tmux sessions and preload prior scrollback via `capture-pane`. tmux absence (and Windows) degrade gracefully to today's direct-spawn behaviour with layout-only restore.

**Tech Stack:** Rust (Tauri commands, `portable_pty`, `std::process::Command` for tmux control), TypeScript/React (Zustand-free hooks, `@tauri-apps/plugin-store` `LazyStore`, `@tauri-apps/api/window` `onCloseRequested`), Vitest (pure unit tests), `cargo test` (Rust unit tests).

---

## Background: how the code works today (read before starting)

- **PTY backend** (`src-tauri/src/modules/pty/`): `pty_open` (mod.rs:38) allocates a monotonic `u32` id, calls `session::spawn`, stores `Arc<Session>` in `PtyState.sessions: RwLock<HashMap<u32, Arc<Session>>>`. `session::spawn` (session.rs:97) builds a `CommandBuilder` via `shell_init::build_command(cwd, workspace)` (shell_init.rs:50), opens a PTY with `native_pty_system().openpty()`, spawns the shell, and wires reader/flusher/waiter threads. `pty_close` kills the child; `pty_close_all` (mod.rs:165) reaps all sessions — called from `main.tsx:20` on every webview load.
- **Shell command construction** lives entirely in `shell_init.rs`. `build_command` dispatches to `unix::build` (zsh/bash/fish login/interactive flags + shell-integration ZDOTDIR/rcfile) or `windows::build` (pwsh / WSL). This is the function the plan changes to optionally wrap the shell in tmux.
- **Frontend pane model** (`src/modules/terminal/lib/panes.ts`): `PaneNode` is `{ kind: "leaf"; id: number; cwd? }` or `{ kind: "split"; id; dir; children }`. Leaf `id`s are monotonic numbers from `nextIdRef` in `useTabs` (useTabs.ts:155), reset every session.
- **Tabs** (`src/modules/tabs/lib/useTabs.ts`): `useTabs(initial?)` seeds one terminal tab (ids 1 and 2) and exposes `newTab`, `splitActivePane`, `closeTab`, `closePaneByLeaf`, `closeActivePane`, `resetWorkspace`, `updateTab`, `setActiveId`, etc. Closing a terminal tab/pane calls `disposeSession(leafId)`.
- **Session lifecycle** (`src/modules/terminal/lib/useTerminalSession.ts`): a module-level `Map<number, Session>` keyed by `leafId`. `attachSession` calls `openPtyForSession` → `openPty(cols, rows, handlers, cwd)` (pty-bridge.ts). `disposeSession` closes the pty. `respawnSession` recreates it. The renderer pool (`rendererPool.ts`) owns the xterm `Terminal` instances and a `SerializeAddon` per slot; `serializeSlot` already produces an ANSI snapshot of scrollback.
- **App wiring** (`src/app/App.tsx:189`): `useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined)`. Many `useEffect`s for listeners; there is **no** `onCloseRequested` handler today.
- **Boot** (`src/main.tsx`): `await invoke("pty_close_all")` then `await initLaunchDir()` then render `<App />`.
- **Tauri setup** (`src-tauri/src/lib.rs:125`): commands registered in `tauri::generate_handler![...]`. New pty commands must be added here.
- **Store pattern**: `new LazyStore(path, { defaults: {}, autoSave: 200 })`, `store.entries()` for one-roundtrip load, `store.set` / `store.save`. See `src/modules/ai/lib/sessions.ts` and `src/modules/settings/store.ts`.
- **Capabilities**: `src-tauri/capabilities/default.json` already grants `store:default`, `core:event:allow-listen`, `core:window:allow-close`. `onCloseRequested` uses the window event API already permitted.

---

## File Structure

**Rust (new / modified):**
- Create `src-tauri/src/modules/pty/tmux.rs` — tmux command construction (pure arg builders + thin wrappers around `std::process::Command`): socket name, config path/contents, `new-session -A`, `kill-session`, `list-sessions`, `capture-pane`, `tmux -V` detection. Holds all unit-testable arg logic.
- Modify `src-tauri/src/modules/pty/mod.rs` — register `tmux` module; add `pty_tmux_available`, `pty_kill_persistent`, `pty_gc_persistent` commands; thread an optional `persist_id` through `pty_open`.
- Modify `src-tauri/src/modules/pty/session.rs` — `spawn` accepts an optional tmux launch spec and uses it instead of the bare shell command.
- Modify `src-tauri/src/modules/pty/shell_init.rs` — add `build_tmux_command(persist_id, cwd, workspace, cols, rows, config_path)` that wraps the resolved inner shell argv as the tmux session's command.
- Modify `src-tauri/src/lib.rs` — register the three new commands.

**TypeScript (new / modified):**
- Modify `src/modules/terminal/lib/panes.ts` — add `uuid: string` to the leaf variant + a `newLeafUuid()` helper + `findLeafUuid`.
- Modify `src/modules/tabs/lib/useTabs.ts` — generate a `uuid` for every leaf created; thread through split/new/reset.
- Create `src/modules/workspace/lib/workspaceStore.ts` — serialize/deserialize the workspace to `terax-workspace.json`; pure (de)serialization helpers + a debounced `LazyStore` writer.
- Create `src/modules/workspace/lib/workspaceStore.test.ts` — pure round-trip / GC-selection / session-name tests (tabLabel.test.ts style).
- Modify `src/modules/terminal/lib/pty-bridge.ts` — `openPty` accepts an optional `persistId`.
- Modify `src/modules/terminal/lib/useTerminalSession.ts` — thread `persistId` to `openPty`; add a scrollback-preload entry point.
- Modify `src/main.tsx` — narrow `pty_close_all` semantics ordering; run startup GC after workspace load.
- Modify `src/app/App.tsx` — load workspace on mount instead of fresh tab; debounced persistence on changes; `onCloseRequested` flush; wire `pty_kill_persistent` into close paths; tmux-missing one-time notice.
- Modify `src/modules/settings/store.ts` — (only if a new pref is needed; see Task 12 — none currently required, scrollback pref reused).

---

## Phase 0 — Shared prerequisite: stable per-leaf uuid

> This `uuid` is the SHARED foundation. The activity-indicator feature will reuse it. Land it first, in isolation, before any tmux work.

### Task 1: Add a stable `uuid` to leaf PaneNodes

**Files:**
- Modify: `src/modules/terminal/lib/panes.ts`
- Test: `src/modules/terminal/lib/panes.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `src/modules/terminal/lib/panes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  findLeafUuid,
  newLeafUuid,
  splitLeaf,
  type PaneNode,
} from "./panes";

describe("leaf uuid", () => {
  it("newLeafUuid returns a non-empty unique string", () => {
    const a = newLeafUuid();
    const b = newLeafUuid();
    expect(a).toMatch(/\S/);
    expect(a).not.toBe(b);
  });

  it("findLeafUuid returns the uuid of a matching leaf", () => {
    const tree: PaneNode = { kind: "leaf", id: 2, uuid: "u-2" };
    expect(findLeafUuid(tree, 2)).toBe("u-2");
    expect(findLeafUuid(tree, 99)).toBeUndefined();
  });

  it("splitLeaf carries a uuid onto the new leaf", () => {
    const tree: PaneNode = { kind: "leaf", id: 2, uuid: "u-2" };
    const next = splitLeaf(tree, 2, 3, 4, "row", undefined, "u-4");
    const ids: string[] = [];
    const walk = (n: PaneNode) =>
      n.kind === "leaf" ? ids.push(n.uuid) : n.children.forEach(walk);
    walk(next);
    expect(ids).toContain("u-2");
    expect(ids).toContain("u-4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/terminal/lib/panes.test.ts`
Expected: FAIL — `findLeafUuid`/`newLeafUuid` not exported; `splitLeaf` arity mismatch.

- [ ] **Step 3: Implement the uuid field and helpers**

In `src/modules/terminal/lib/panes.ts`, change the leaf variant and add helpers:

```ts
export type PaneNode =
  | { kind: "leaf"; id: PaneId; uuid: string; cwd?: string }
  | {
      kind: "split";
      id: PaneId;
      dir: SplitDir;
      children: PaneNode[];
    };

export function newLeafUuid(): string {
  // crypto.randomUUID is available in the Tauri webview (secure context).
  return crypto.randomUUID();
}

export function findLeafUuid(n: PaneNode, id: PaneId): string | undefined {
  if (isLeaf(n)) return n.id === id ? n.uuid : undefined;
  for (const c of n.children) {
    const found = findLeafUuid(c, id);
    if (found !== undefined) return found;
  }
  return undefined;
}
```

Update `splitLeaf` to take and apply a `newLeafUuid` argument (append a trailing param so existing call shape is explicit):

```ts
export function splitLeaf(
  tree: PaneNode,
  targetId: PaneId,
  newSplitId: PaneId,
  newLeafId: PaneId,
  dir: SplitDir,
  newCwd?: string,
  newLeafUuidValue?: string,
): PaneNode {
  // ...both places that build `const newLeaf: PaneNode = { kind: "leaf", ... }`
  // become:
  // const newLeaf: PaneNode = {
  //   kind: "leaf",
  //   id: newLeafId,
  //   uuid: newLeafUuidValue ?? newLeafUuid(),
  //   cwd: newCwd,
  // };
}
```

Apply that `newLeaf` shape at **both** construction sites in `splitLeaf` (the same-direction-append branch and the leaf-wrap branch).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/terminal/lib/panes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full typecheck to find every leaf-construction site**

Run: `npx tsc --noEmit`
Expected: FAIL listing the spots in `useTabs.ts` that build leaves without `uuid`. (Fixed in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/terminal/lib/panes.ts src/modules/terminal/lib/panes.test.ts
git commit -m "feat(panes): add stable per-leaf uuid"
```

### Task 2: Generate a uuid for every leaf created in useTabs

**Files:**
- Modify: `src/modules/tabs/lib/useTabs.ts`
- Modify: `src/modules/tabs/lib/tabLabel.test.ts` (fixture needs `uuid`)

- [ ] **Step 1: Update the tabLabel test fixture so it compiles**

In `src/modules/tabs/lib/tabLabel.test.ts`, add a uuid to the fixture leaf:

```ts
    paneTree: { kind: "leaf", id: 2, uuid: "u-test", cwd: undefined },
```

(Place `uuid` before `cwd`; keep the rest of the fixture unchanged.)

- [ ] **Step 2: Run the test to confirm the fixture compiles and still passes**

Run: `npx vitest run src/modules/tabs/lib/tabLabel.test.ts`
Expected: PASS (behaviour unchanged; only the type now requires `uuid`).

- [ ] **Step 3: Add uuid at every leaf-creation site in useTabs**

In `src/modules/tabs/lib/useTabs.ts`:

Import the helper:

```ts
import {
  // ...existing imports...
  newLeafUuid,
} from "@/modules/terminal/lib/panes";
```

Every place that builds `paneTree: { kind: "leaf", id: leafId, cwd }` must become:

```ts
paneTree: { kind: "leaf", id: leafId, uuid: newLeafUuid(), cwd },
```

These sites are: the `useState` initializer, `newTab`, `newAgentTab`, `newPrivateTab`, and `resetWorkspace`. In `splitActivePane`, pass a fresh uuid into `splitLeaf`:

```ts
const paneTree = splitLeaf(
  t.paneTree,
  t.activeLeafId,
  splitId,
  leafId,
  dir,
  t.cwd,
  newLeafUuid(),
);
```

- [ ] **Step 4: Typecheck clean**

Run: `npx tsc --noEmit`
Expected: PASS — no remaining leaf without `uuid`.

- [ ] **Step 5: Run the tabs + panes test suites**

Run: `npx vitest run src/modules/tabs src/modules/terminal/lib/panes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/tabs/lib/useTabs.ts src/modules/tabs/lib/tabLabel.test.ts
git commit -m "feat(tabs): assign stable uuid to every terminal leaf"
```

---

## Phase 1 — tmux command construction (Rust, no spawning yet)

### Task 3: Pure tmux arg builders + config + detection

**Files:**
- Create: `src-tauri/src/modules/pty/tmux.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs` (add `mod tmux;`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/modules/pty/tmux.rs` with the test module first (write the API in the same file in the next step):

```rust
//! tmux control-command construction for session persistence.
//!
//! All sessions live on a dedicated socket (`-L terax`) so Terax never
//! touches the user's own tmux server/config. One tmux session per Terax
//! leaf, named `terax_<uuid>`. We do NOT use tmux's own splitting — Terax
//! owns the layout; each session is a single window/pane.

pub const SOCKET: &str = "terax";
pub const SESSION_PREFIX: &str = "terax_";

/// Injected minimal config. Written once to `<config_dir>/tmux.conf` and
/// passed via `-f`. Keeps tmux invisible: no status line, no prefix, no
/// mouse capture (xterm/Terax owns it), sessions survive detach.
pub fn config_contents(history_limit: u32) -> String {
    format!(
        "set -g status off\n\
         set -g escape-time 0\n\
         set -g prefix None\n\
         unbind C-b\n\
         set -g mouse off\n\
         set -g history-limit {history_limit}\n\
         set -g default-terminal \"tmux-256color\"\n\
         set -g allow-passthrough on\n\
         set -g destroy-unattached off\n"
    )
}

pub fn session_name(uuid: &str) -> String {
    format!("{SESSION_PREFIX}{uuid}")
}

/// `tmux -L terax -f <config> new-session -A -s <name> -x <cols> -y <rows> -c <cwd> [-- <shell argv...>]`
/// `-A` = attach-if-exists-else-create: one code path for spawn and reattach.
pub fn new_session_args(
    config_path: &str,
    name: &str,
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
    shell_argv: &[String],
) -> Vec<String> {
    let mut a = vec![
        "-L".into(), SOCKET.into(),
        "-f".into(), config_path.into(),
        "new-session".into(),
        "-A".into(),
        "-s".into(), name.into(),
        "-x".into(), cols.to_string(),
        "-y".into(), rows.to_string(),
    ];
    if let Some(cwd) = cwd {
        a.push("-c".into());
        a.push(cwd.into());
    }
    if !shell_argv.is_empty() {
        a.push("--".into());
        for arg in shell_argv {
            a.push(arg.clone());
        }
    }
    a
}

pub fn kill_session_args(name: &str) -> Vec<String> {
    vec!["-L".into(), SOCKET.into(), "kill-session".into(), "-t".into(), name.into()]
}

/// `tmux -L terax list-sessions -F '#{session_name}'` — used by GC.
pub fn list_sessions_args() -> Vec<String> {
    vec![
        "-L".into(), SOCKET.into(),
        "list-sessions".into(),
        "-F".into(), "#{session_name}".into(),
    ]
}

/// `tmux -L terax capture-pane -p -t <name> -S -<lines>` — last `lines` of
/// scrollback as plain text, for preload into xterm on reattach.
pub fn capture_pane_args(name: &str, lines: u32) -> Vec<String> {
    vec![
        "-L".into(), SOCKET.into(),
        "capture-pane".into(),
        "-p".into(),
        "-t".into(), name.into(),
        "-S".into(), format!("-{lines}"),
    ]
}

/// Given tmux's `list-sessions` output and the set of session names still
/// referenced by the persisted workspace, return the `terax_*` names to kill.
/// Never touches sessions that don't carry our prefix (defensive — the socket
/// is ours, but a stray `tmux -L terax` by the user shouldn't be reaped).
pub fn gc_targets(live: &[String], referenced: &[String]) -> Vec<String> {
    live.iter()
        .filter(|n| n.starts_with(SESSION_PREFIX))
        .filter(|n| !referenced.iter().any(|r| r == *n))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_name_prefixes_uuid() {
        assert_eq!(session_name("abc-123"), "terax_abc-123");
    }

    #[test]
    fn new_session_uses_attach_or_create_and_dims() {
        let args = new_session_args(
            "/cfg/tmux.conf",
            "terax_x",
            120,
            40,
            Some("/home/u/proj"),
            &["/bin/zsh".into(), "-l".into()],
        );
        assert_eq!(
            args,
            vec![
                "-L", "terax", "-f", "/cfg/tmux.conf",
                "new-session", "-A", "-s", "terax_x",
                "-x", "120", "-y", "40",
                "-c", "/home/u/proj",
                "--", "/bin/zsh", "-l",
            ]
        );
    }

    #[test]
    fn new_session_omits_cwd_and_argv_when_absent() {
        let args = new_session_args("/cfg/tmux.conf", "terax_x", 80, 24, None, &[]);
        assert_eq!(
            args,
            vec![
                "-L", "terax", "-f", "/cfg/tmux.conf",
                "new-session", "-A", "-s", "terax_x",
                "-x", "80", "-y", "24",
            ]
        );
    }

    #[test]
    fn kill_session_targets_name() {
        assert_eq!(
            kill_session_args("terax_x"),
            vec!["-L", "terax", "kill-session", "-t", "terax_x"]
        );
    }

    #[test]
    fn capture_pane_requests_negative_start() {
        assert_eq!(
            capture_pane_args("terax_x", 2000),
            vec!["-L", "terax", "capture-pane", "-p", "-t", "terax_x", "-S", "-2000"]
        );
    }

    #[test]
    fn gc_kills_only_unreferenced_terax_sessions() {
        let live = vec![
            "terax_a".into(),
            "terax_b".into(),
            "user_shell".into(),
        ];
        let referenced = vec!["terax_a".into()];
        assert_eq!(gc_targets(&live, &referenced), vec!["terax_b".to_string()]);
    }

    #[test]
    fn config_contains_required_settings() {
        let cfg = config_contents(5000);
        assert!(cfg.contains("status off"));
        assert!(cfg.contains("prefix None"));
        assert!(cfg.contains("destroy-unattached off"));
        assert!(cfg.contains("history-limit 5000"));
        assert!(cfg.contains("allow-passthrough on"));
    }
}
```

- [ ] **Step 2: Register the module so it compiles**

In `src-tauri/src/modules/pty/mod.rs`, add at the top with the other `mod` lines:

```rust
pub(crate) mod tmux;
```

- [ ] **Step 3: Run the tmux tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::tmux`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/tmux.rs src-tauri/src/modules/pty/mod.rs
git commit -m "feat(pty): tmux command construction (pure, unit-tested)"
```

### Task 4: tmux availability detection + config materialization

**Files:**
- Modify: `src-tauri/src/modules/pty/tmux.rs`

- [ ] **Step 1: Write the failing test for the availability parser**

`tmux -V` cannot be reliably spawned in CI, so split parsing from spawning. Add to the `tests` module in `tmux.rs`:

```rust
    #[test]
    fn parses_version_line() {
        assert_eq!(parse_version("tmux 3.4\n"), Some("3.4".to_string()));
        assert_eq!(parse_version("tmux next-3.5"), Some("next-3.5".to_string()));
        assert_eq!(parse_version("garbage"), None);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::tmux::tests::parses_version_line`
Expected: FAIL — `parse_version` not found.

- [ ] **Step 3: Implement parsing + spawning wrappers**

Add to `tmux.rs` (outside the test module):

```rust
use std::path::{Path, PathBuf};
use std::process::Command;

/// Extract the version token from `tmux -V` output, e.g. "tmux 3.4" -> "3.4".
pub fn parse_version(out: &str) -> Option<String> {
    out.trim()
        .strip_prefix("tmux ")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Whether tmux is usable on this platform. Windows always returns false
/// (process survival is out of scope there — falls back to direct spawn).
pub fn detect_available() -> bool {
    if cfg!(windows) {
        return false;
    }
    Command::new("tmux")
        .arg("-V")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .and_then(|s| parse_version(&s))
        })
        .is_some()
}

/// Path to the injected config, materialized under the shell-integration
/// cache root next to the existing zsh/bash configs.
pub fn config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".cache").join("terax");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("tmux.conf"))
}

/// Write the config if its contents changed (atomic replace, mirrors
/// shell_init::write_if_changed).
pub fn ensure_config(history_limit: u32) -> Result<PathBuf, String> {
    let path = config_path()?;
    let contents = config_contents(history_limit);
    write_if_changed(&path, &contents)?;
    Ok(path)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".__terax_tmp__");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

/// Run a tmux control command (kill/list/capture) and return stdout. Used for
/// commands that do not become the PTY's foreground process.
pub fn run_control(args: &[String]) -> Result<String, String> {
    let out = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("tmux spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
```

- [ ] **Step 4: Run to verify the parser test passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::tmux`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/tmux.rs
git commit -m "feat(pty): tmux detection, config materialization, control runner"
```

### Task 5: Build the inner shell argv and wrap it in tmux

**Files:**
- Modify: `src-tauri/src/modules/pty/shell_init.rs`
- Test: inline `#[cfg(test)]` in `shell_init.rs`

> Today `build_command` returns a `CommandBuilder` for the shell directly. For
> tmux we need (a) the shell program + args as a plain argv vector and (b) the
> environment to set on the tmux process (which tmux propagates into the
> session). We add a function that returns those parts so `tmux.rs` arg builders
> can consume them, without disturbing the existing direct-spawn path.

- [ ] **Step 1: Write the failing test**

Add to the bottom of `shell_init.rs` (gated for unix, since the Windows path never uses tmux):

```rust
#[cfg(all(test, unix))]
mod tmux_wrap_tests {
    use super::*;

    #[test]
    fn inner_shell_argv_is_nonempty_and_starts_with_a_shell() {
        let argv = inner_shell_argv();
        assert!(!argv.is_empty());
        // First element is an absolute path to a shell binary.
        assert!(argv[0].starts_with('/'), "argv[0] = {}", argv[0]);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml shell_init`
Expected: FAIL — `inner_shell_argv` not found.

- [ ] **Step 3: Extract the argv builder (unix)**

In the `unix` module of `shell_init.rs`, refactor `build` so the program+args are produced by a reusable helper, then expose a public `inner_shell_argv` at module scope. Add (unix only):

```rust
#[cfg(unix)]
pub(super) fn inner_shell_argv() -> Vec<String> {
    let (shell, shell_path) = unix::Shell::detect();
    let mut argv = vec![shell_path.clone()];
    match shell {
        unix::Shell::Zsh => argv.push("-l".into()),
        unix::Shell::Bash => argv.push("-i".into()),
        unix::Shell::Fish => argv.push("-i".into()),
        unix::Shell::Other => {}
    }
    argv
}
```

Make `unix::Shell` and its `detect` visible to the parent (`pub(super) enum Shell` / `pub(super) fn detect`). Note: ZDOTDIR/rcfile setup still happens by calling the existing `prepare_*` functions; expose a helper that performs side-effect setup and returns the env pairs:

```rust
#[cfg(unix)]
pub(super) fn inner_shell_env(cwd: Option<String>) -> Vec<(String, String)> {
    // Reuses apply_common's logic but returns env pairs for tmux to carry.
    let mut env: Vec<(String, String)> = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERAX_TERMINAL".into(), "1".into()),
    ];
    // UTF-8 locale fallback (mirror ensure_utf8_locale).
    let is_utf8 = |v: &str| {
        let up = v.to_ascii_uppercase();
        up.contains("UTF-8") || up.contains("UTF8")
    };
    let already = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref().is_some_and(is_utf8));
    if !already {
        #[cfg(target_os = "macos")]
        let fallback = "en_US.UTF-8";
        #[cfg(all(unix, not(target_os = "macos")))]
        let fallback = "C.UTF-8";
        env.push(("LANG".into(), fallback.into()));
    }
    // Shell-integration env (ZDOTDIR for zsh) — perform the same side-effecting
    // prepare_* calls the direct path does, and return the resulting env.
    let (shell, _path) = unix::Shell::detect();
    if let unix::Shell::Zsh = shell {
        if let Ok(zdotdir) = unix::prepare_zdotdir() {
            if let Ok(user_zd) = std::env::var("ZDOTDIR") {
                if std::path::Path::new(&user_zd) != zdotdir.as_path() {
                    env.push(("TERAX_USER_ZDOTDIR".into(), user_zd));
                }
            }
            env.push(("ZDOTDIR".into(), zdotdir.to_string_lossy().to_string()));
        }
    }
    // bash/fish integration is via --rcfile/conf.d on the inner argv / FS, not
    // env; trigger their prepare_* so the files exist.
    match shell {
        unix::Shell::Bash => { let _ = unix::prepare_bash_rcfile(); }
        unix::Shell::Fish => { let _ = unix::prepare_fish_conf_d(); }
        _ => {}
    }
    let _ = cwd; // tmux receives cwd via -c, not env
    env
}
```

> Bash `--rcfile <path> -i` must be on the inner argv. Update `inner_shell_argv`
> to append `--rcfile <rc>` for bash when `prepare_bash_rcfile()` succeeds, so
> the tmux-launched bash gets shell integration the same way the direct path
> does. Make `prepare_zdotdir`, `prepare_bash_rcfile`, `prepare_fish_conf_d`
> `pub(super)`.

- [ ] **Step 4: Run to verify the test passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml shell_init`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/shell_init.rs
git commit -m "feat(pty): expose inner shell argv/env for tmux wrapping"
```

---

## Phase 2 — Wire tmux into spawn + new Tauri commands

### Task 6: Spawn through tmux when a persist id is provided

**Files:**
- Modify: `src-tauri/src/modules/pty/session.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs`

- [ ] **Step 1: Add a launch-spec parameter to `session::spawn`**

In `session.rs`, change `spawn`'s signature to accept an optional tmux launch. Define a small struct at the top of `session.rs`:

```rust
/// When present, the PTY runs `tmux <args>` instead of the bare shell, so the
/// shell process survives the app via the tmux server. `cwd`/`env` still apply
/// to the tmux client process (tmux carries env into the session on create).
pub struct TmuxLaunch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}
```

Change the signature:

```rust
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    tmux: Option<TmuxLaunch>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
```

Replace the command construction (`let cmd = shell_init::build_command(cwd, workspace)?;`) with:

```rust
    let cmd = match tmux {
        Some(launch) => {
            let mut cmd = portable_pty::CommandBuilder::new("tmux");
            for arg in &launch.args {
                cmd.arg(arg);
            }
            for (k, v) in &launch.env {
                cmd.env(k, v);
            }
            cmd
        }
        None => shell_init::build_command(cwd, workspace)?,
    };
```

- [ ] **Step 2: Update the `pty_open` caller and add persist plumbing in mod.rs**

In `mod.rs`, extend `pty_open` to take `persist_id: Option<String>` and build the tmux launch. Change the signature to add the param (after `workspace`):

```rust
    workspace: Option<WorkspaceEnv>,
    persist_id: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
```

Inside, after `authorize_user_spawn_cwd(...)?;` and before spawning, build the optional tmux launch (unix only; Windows always None):

```rust
    let tmux_launch = build_tmux_launch(persist_id.as_deref(), cwd.as_deref(), cols, rows);
```

and add a helper in `mod.rs`:

```rust
#[cfg(unix)]
fn build_tmux_launch(
    persist_id: Option<&str>,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Option<session::TmuxLaunch> {
    let persist_id = persist_id?;
    if !tmux::detect_available() {
        return None;
    }
    // history-limit = terminal scrollback default; the frontend caps capture to
    // this when preloading. Keep in sync with TERMINAL_SCROLLBACK_MAX upstream.
    let cfg = tmux::ensure_config(50_000).ok()?;
    let cfg = cfg.to_string_lossy().to_string();
    let name = tmux::session_name(persist_id);
    let argv = shell_init::inner_shell_argv();
    let env = shell_init::inner_shell_env(cwd.map(|s| s.to_string()));
    let args = tmux::new_session_args(&cfg, &name, cols, rows, cwd, &argv);
    Some(session::TmuxLaunch { args, env })
}

#[cfg(windows)]
fn build_tmux_launch(
    _persist_id: Option<&str>,
    _cwd: Option<&str>,
    _cols: u16,
    _rows: u16,
) -> Option<session::TmuxLaunch> {
    None
}
```

Pass `tmux_launch` into the `spawn_blocking` closure:

```rust
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, app, cols, rows, cwd, workspace, tmux_launch, on_data, on_exit)
            .map(|(s, _)| s)
    })
```

Add `use tmux;`-style access by referring to `tmux::` (the module is already declared `pub(crate) mod tmux;`). Add `use shell_init;` is unnecessary — refer as `shell_init::`. Ensure `shell_init` is imported (it is via `pub(crate) mod shell_init;`).

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: SUCCESS. (No new unit test here — spawning tmux is covered by the guarded integration test in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/session.rs src-tauri/src/modules/pty/mod.rs
git commit -m "feat(pty): launch shell via tmux when a persist id is provided"
```

### Task 7: New Tauri commands — availability, kill, GC, capture

**Files:**
- Modify: `src-tauri/src/modules/pty/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the commands to mod.rs**

```rust
#[tauri::command]
pub fn pty_tmux_available() -> bool {
    tmux::detect_available()
}

#[tauri::command]
pub fn pty_kill_persistent(name: String) -> Result<(), String> {
    if !name.starts_with(tmux::SESSION_PREFIX) {
        return Err(format!("refusing to kill non-terax session: {name}"));
    }
    if !tmux::detect_available() {
        return Ok(());
    }
    match tmux::run_control(&tmux::kill_session_args(&name)) {
        Ok(_) => {
            log::info!("pty_kill_persistent: killed {name}");
            Ok(())
        }
        // kill-session on an already-gone session errors; treat as success.
        Err(e) => {
            log::debug!("pty_kill_persistent {name}: {e}");
            Ok(())
        }
    }
}

/// Kill every `terax_*` session NOT in `referenced` (full session names).
#[tauri::command]
pub fn pty_gc_persistent(referenced: Vec<String>) -> Result<usize, String> {
    if !tmux::detect_available() {
        return Ok(0);
    }
    let out = match tmux::run_control(&tmux::list_sessions_args()) {
        Ok(o) => o,
        // No server / no sessions -> nothing to GC.
        Err(_) => return Ok(0),
    };
    let live: Vec<String> = out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let targets = tmux::gc_targets(&live, &referenced);
    let n = targets.len();
    for name in targets {
        let _ = tmux::run_control(&tmux::kill_session_args(&name));
    }
    if n > 0 {
        log::info!("pty_gc_persistent: reaped {n} orphan tmux session(s)");
    }
    Ok(n)
}

/// Last `lines` of a session's scrollback as plain text (for xterm preload).
#[tauri::command]
pub fn pty_capture_scrollback(name: String, lines: u32) -> Result<String, String> {
    if !name.starts_with(tmux::SESSION_PREFIX) || !tmux::detect_available() {
        return Ok(String::new());
    }
    tmux::run_control(&tmux::capture_pane_args(&name, lines)).or_else(|e| {
        log::debug!("pty_capture_scrollback {name}: {e}");
        Ok(String::new())
    })
}
```

- [ ] **Step 2: Register the commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the `tauri::generate_handler![...]` block, right after `pty::pty_close_all,`:

```rust
            pty::pty_tmux_available,
            pty::pty_kill_persistent,
            pty::pty_gc_persistent,
            pty::pty_capture_scrollback,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: SUCCESS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/mod.rs src-tauri/src/lib.rs
git commit -m "feat(pty): tmux availability, kill, GC, capture commands"
```

### Task 8: Guarded tmux integration test (skipped when tmux absent)

**Files:**
- Modify: `src-tauri/src/modules/pty/tmux.rs` (add a guarded test)

- [ ] **Step 1: Write the guarded integration test**

Add to the `tests` module in `tmux.rs`:

```rust
    // Spawns a real tmux on the terax socket. Skipped automatically when tmux
    // is unavailable (CI without tmux). Cleans up the session it creates.
    #[test]
    fn integration_create_list_capture_kill_roundtrip() {
        if !detect_available() {
            eprintln!("skipping: tmux not installed");
            return;
        }
        let cfg = ensure_config(2000).expect("config");
        let cfg = cfg.to_string_lossy().to_string();
        let name = session_name("itest-roundtrip");
        // Create detached (-d) so the test process isn't attached as a client.
        let mut create = new_session_args(&cfg, &name, 80, 24, None, &[]);
        // Insert -d right after "new-session".
        let pos = create.iter().position(|a| a == "new-session").unwrap();
        create.insert(pos + 1, "-d".into());
        let _ = run_control(&create);

        let listed = run_control(&list_sessions_args()).unwrap_or_default();
        assert!(listed.contains(&name), "session should be listed: {listed}");

        // capture-pane returns Ok (content may be empty for a fresh shell).
        let _ = run_control(&capture_pane_args(&name, 100));

        let _ = run_control(&kill_session_args(&name));
        let after = run_control(&list_sessions_args()).unwrap_or_default();
        assert!(!after.contains(&name), "session should be gone: {after}");
    }
```

- [ ] **Step 2: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::tmux -- --nocapture`
Expected: PASS (roundtrip runs if tmux present, otherwise prints "skipping" and passes).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/modules/pty/tmux.rs
git commit -m "test(pty): guarded tmux integration roundtrip"
```

---

## Phase 3 — Frontend persist plumbing

### Task 9: Thread persistId through openPty and the session layer

**Files:**
- Modify: `src/modules/terminal/lib/pty-bridge.ts`
- Modify: `src/modules/terminal/lib/useTerminalSession.ts`

- [ ] **Step 1: Add `persistId` to `openPty`**

In `pty-bridge.ts`, add an optional 5th parameter and pass it as the `persistId` invoke arg (note: Tauri maps the Rust snake_case `persist_id` from a camelCase key automatically):

```ts
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  persistId?: string,
): Promise<PtySession> {
  // ...existing channel setup...
  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    persistId: persistId ?? null,
    onData,
    onExit,
  });
  // ...rest unchanged...
}
```

- [ ] **Step 2: Carry a `persistId` on each Session and pass it to openPty**

In `useTerminalSession.ts`:

Add `persistId: string | undefined` to the `Session` type and to `ensureSession`'s params + initializer:

```ts
type Session = {
  // ...existing fields...
  persistId: string | undefined;
};

function ensureSession(
  leafId: number,
  initialCwd?: string,
  persistId?: string,
): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;
  const session: Session = {
    // ...existing fields...
    persistId,
  };
  // ...
}
```

In `openPtyForSession`, pass it through:

```ts
  return openPty(
    startCols,
    startRows,
    { /* handlers unchanged */ },
    cwd,
    s.persistId,
  );
```

Add `persistId` to the `Options` type and `useTerminalSession` params, and pass it to `ensureSession` in the mount effect:

```ts
type Options = {
  leafId: number;
  // ...existing...
  persistId?: string;
};

export function useTerminalSession({
  leafId,
  // ...existing...
  persistId,
}: Options) {
  // ...
  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwd, persistId);
    // ...
  }, [leafId, container, initialCwd, persistId]);
}
```

- [ ] **Step 3: Add a scrollback-preload entry point**

Still in `useTerminalSession.ts`, export a function the App calls once after a leaf's tmux session is known to be alive, to push captured scrollback into the dormant ring / slot before live bytes arrive:

```ts
import { invoke } from "@tauri-apps/api/core";

/** Preload prior tmux scrollback into the xterm buffer on reattach. The text
 *  is plain (capture-pane -p); append a newline so the live prompt starts on a
 *  fresh line. No-op when capture returns empty (fresh session / no tmux). */
export async function preloadScrollback(
  leafId: number,
  sessionName: string,
  lines: number,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  let text = "";
  try {
    text = await invoke<string>("pty_capture_scrollback", {
      name: sessionName,
      lines,
    });
  } catch {
    return;
  }
  if (!text) return;
  const bytes = new TextEncoder().encode(text.replace(/\n/g, "\r\n") + "\r\n");
  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/terminal/lib/pty-bridge.ts src/modules/terminal/lib/useTerminalSession.ts
git commit -m "feat(terminal): thread persistId + scrollback preload through session layer"
```

### Task 10: Workspace serialization + store (pure logic first)

**Files:**
- Create: `src/modules/workspace/lib/workspaceStore.ts`
- Create: `src/modules/workspace/lib/workspaceStore.test.ts`

> Verify the target dir exists: `src/modules/workspace/` is a module. If there
> is no `lib/` subdir, create it. Mirror the import alias style (`@/modules/...`).

- [ ] **Step 1: Write the failing pure tests**

Create `src/modules/workspace/lib/workspaceStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import {
  referencedSessionNames,
  serializeWorkspace,
  deserializeWorkspace,
  type PersistedWorkspace,
} from "./workspaceStore";

const terminalTab = (over: Partial<Extract<Tab, { kind: "terminal" }>> = {}) =>
  ({
    id: 1,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, uuid: "u-2", cwd: "/a" },
    activeLeafId: 2,
    ...over,
  }) as Tab;

const editorTab = (): Tab =>
  ({ id: 3, kind: "editor", title: "f.ts", path: "/a/f.ts", dirty: false, preview: false }) as Tab;

describe("workspace serialization", () => {
  it("round-trips terminal + editor tabs and active id", () => {
    const tabs: Tab[] = [terminalTab(), editorTab()];
    const snap = serializeWorkspace(tabs, 1);
    const { tabs: out, activeId } = deserializeWorkspace(snap);
    expect(activeId).toBe(1);
    expect(out).toHaveLength(2);
    const t = out[0];
    expect(t.kind).toBe("terminal");
    if (t.kind === "terminal") {
      expect(t.paneTree).toEqual({ kind: "leaf", id: 2, uuid: "u-2", cwd: "/a" });
    }
  });

  it("excludes private terminals from the snapshot", () => {
    const tabs: Tab[] = [terminalTab(), terminalTab({ id: 9, private: true })];
    const snap = serializeWorkspace(tabs, 1);
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0].id).toBe(1);
  });

  it("drops volatile non-restorable tabs (ai-diff, git-diff, git-commit-file)", () => {
    const tabs = [
      terminalTab(),
      { id: 4, kind: "ai-diff", title: "x", path: "/a", originalContent: "", proposedContent: "", approvalId: "ap", status: "pending", isNewFile: false },
    ] as Tab[];
    const snap = serializeWorkspace(tabs, 1);
    expect(snap.tabs.map((t) => t.kind)).toEqual(["terminal"]);
  });

  it("referencedSessionNames returns terax_<uuid> for every persisted leaf", () => {
    const tabs: Tab[] = [
      terminalTab({
        paneTree: {
          kind: "split",
          id: 5,
          dir: "row",
          children: [
            { kind: "leaf", id: 2, uuid: "u-2", cwd: "/a" },
            { kind: "leaf", id: 6, uuid: "u-6", cwd: "/b" },
          ],
        },
      }),
    ];
    const snap = serializeWorkspace(tabs, 1);
    expect(referencedSessionNames(snap).sort()).toEqual(["terax_u-2", "terax_u-6"]);
  });

  it("active id falls back to the first surviving tab when the active was dropped", () => {
    const tabs: Tab[] = [terminalTab({ id: 9, private: true }), terminalTab({ id: 1 })];
    const snap = serializeWorkspace(tabs, 9); // active was the private tab
    const { activeId } = deserializeWorkspace(snap);
    expect(activeId).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/workspace/lib/workspaceStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store module**

Create `src/modules/workspace/lib/workspaceStore.ts`:

```ts
import { LazyStore } from "@tauri-apps/plugin-store";
import type { Tab } from "@/modules/tabs";
import { leafIds, findLeafUuid, type PaneNode } from "@/modules/terminal/lib/panes";

const SESSION_PREFIX = "terax_";

// Only these tab kinds restore by descriptor. ai-diff/git-diff/git-commit-file
// are transient (tied to a live approval or working-tree state) and are dropped.
const RESTORABLE_KINDS = new Set([
  "terminal",
  "editor",
  "preview",
  "markdown",
  "git-history",
]);

export type PersistedWorkspace = {
  version: 1;
  activeId: number;
  tabs: Tab[];
};

const STORE_PATH = "terax-workspace.json";
const KEY = "workspace";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Pure: produce the persistable snapshot. Excludes private terminals and
 *  non-restorable tab kinds. Editor `preview`/`dirty` flags are normalized. */
export function serializeWorkspace(
  tabs: Tab[],
  activeId: number,
): PersistedWorkspace {
  const kept = tabs.filter((t) => {
    if (!RESTORABLE_KINDS.has(t.kind)) return false;
    if (t.kind === "terminal" && t.private) return false;
    return true;
  });
  const nextActive = kept.some((t) => t.id === activeId)
    ? activeId
    : (kept[0]?.id ?? activeId);
  return { version: 1, activeId: nextActive, tabs: kept };
}

/** Pure inverse — currently a structural pass-through plus active resolution.
 *  Kept as a function so future schema migration has a single seam. */
export function deserializeWorkspace(snap: PersistedWorkspace): {
  tabs: Tab[];
  activeId: number;
} {
  const tabs = snap.tabs ?? [];
  const activeId = tabs.some((t) => t.id === snap.activeId)
    ? snap.activeId
    : (tabs[0]?.id ?? snap.activeId);
  return { tabs, activeId };
}

/** Pure: every tmux session name referenced by the snapshot's terminal leaves. */
export function referencedSessionNames(snap: PersistedWorkspace): string[] {
  const names: string[] = [];
  for (const t of snap.tabs) {
    if (t.kind !== "terminal") continue;
    for (const id of leafIds(t.paneTree)) {
      const uuid = findLeafUuid(t.paneTree as PaneNode, id);
      if (uuid) names.push(`${SESSION_PREFIX}${uuid}`);
    }
  }
  return names;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persist (200ms). Mirrors the autoSave cadence used elsewhere. */
export function scheduleWorkspaceSave(tabs: Tab[], activeId: number): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistWorkspace(tabs, activeId);
  }, 200);
}

/** Immediate, awaited persist — used by the window-close flush. */
export async function persistWorkspace(
  tabs: Tab[],
  activeId: number,
): Promise<void> {
  const snap = serializeWorkspace(tabs, activeId);
  await store.set(KEY, snap);
  await store.save();
}

/** Returns null on first run (no file). */
export async function loadWorkspace(): Promise<PersistedWorkspace | null> {
  try {
    const snap = await store.get<PersistedWorkspace>(KEY);
    if (!snap || snap.version !== 1 || !Array.isArray(snap.tabs)) return null;
    return snap;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run src/modules/workspace/lib/workspaceStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Export from the workspace module index (if one exists)**

If `src/modules/workspace/index.ts` exists, add:

```ts
export {
  loadWorkspace,
  persistWorkspace,
  scheduleWorkspaceSave,
  referencedSessionNames,
  serializeWorkspace,
  deserializeWorkspace,
  type PersistedWorkspace,
} from "./lib/workspaceStore";
```

If no index re-exports lib helpers today, import directly via the file path in App.tsx instead. Verify by `grep -n "from \"./lib" src/modules/workspace/index.ts` before editing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/workspace/lib/workspaceStore.ts src/modules/workspace/lib/workspaceStore.test.ts
git commit -m "feat(workspace): persisted workspace store + pure (de)serialization"
```

---

## Phase 4 — Restore on launch + persist on change/close

### Task 11: Make useTabs hydratable from a persisted snapshot

**Files:**
- Modify: `src/modules/tabs/lib/useTabs.ts`

> `useTabs` currently always seeds one fresh tab. Add an optional initial-tabs
> path so App can hydrate from `loadWorkspace()` without a flash of the default
> tab. The hook must also keep `nextIdRef` past the max persisted id so new tabs
> don't collide.

- [ ] **Step 1: Accept a full initial state**

Change the `useTabs` signature to accept an optional hydration object alongside the existing `initial`:

```ts
export type WorkspaceHydration = {
  tabs: Tab[];
  activeId: number;
};

export function useTabs(
  initial?: Partial<TerminalTab>,
  hydration?: WorkspaceHydration,
) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    if (hydration && hydration.tabs.length > 0) return hydration.tabs;
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, uuid: newLeafUuid(), cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(
    hydration && hydration.tabs.length > 0 ? hydration.activeId : 1,
  );
  // Start id allocation above the highest persisted numeric id (tab ids + leaf
  // + split ids) so new tabs/leaves never collide with restored ones.
  const nextIdRef = useRef(
    hydration && hydration.tabs.length > 0
      ? maxNodeId(hydration.tabs) + 1
      : 3,
  );
  // ...rest unchanged...
}
```

Add a pure helper near the top of the file:

```ts
function maxNodeId(tabs: Tab[]): number {
  let max = 0;
  const walkPane = (n: PaneNode) => {
    max = Math.max(max, n.id);
    if (n.kind === "split") n.children.forEach(walkPane);
  };
  for (const t of tabs) {
    max = Math.max(max, t.id);
    if (t.kind === "terminal") walkPane(t.paneTree);
  }
  return max;
}
```

(`PaneNode` is already imported from `panes`.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the tabs tests**

Run: `npx vitest run src/modules/tabs`
Expected: PASS (existing tests unaffected; hydration path is additive).

- [ ] **Step 4: Commit**

```bash
git add src/modules/tabs/lib/useTabs.ts
git commit -m "feat(tabs): hydrate useTabs from a persisted workspace snapshot"
```

### Task 12: Load workspace before render; GC orphans; persist on change + close

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/app/App.tsx`

> This wires everything together. There are no new pure tests here (it is
> orchestration); it is covered by the manual verification checklist at the end.
> Keep each sub-change small and re-run `npx tsc --noEmit` after each.

- [ ] **Step 1: Load the workspace snapshot before first render in main.tsx**

In `src/main.tsx`, after `await initLaunchDir();` and before `ReactDOM.createRoot(...)`, load the snapshot and GC orphan tmux sessions. The existing `pty_close_all` (now only detaches PTY client handles from the prior webview — tmux sessions persist) stays first:

```ts
import { loadWorkspace, referencedSessionNames } from "@/modules/workspace/lib/workspaceStore";

// Reap PTY *client* handles orphaned by a prior webview load. tmux sessions
// (when used) survive this — they live in the tmux server, not the app process.
await invoke("pty_close_all").catch(() => {});

await initLaunchDir();

// Load persisted workspace and GC orphan tmux sessions (any terax_* not
// referenced by the snapshot). Pass the snapshot to App via a module global
// the App reads on mount (avoids prop drilling through createRoot).
const persistedWorkspace = await loadWorkspace().catch(() => null);
await invoke("pty_gc_persistent", {
  referenced: persistedWorkspace ? referencedSessionNames(persistedWorkspace) : [],
}).catch(() => {});

(window as unknown as { __TERAX_WORKSPACE__?: unknown }).__TERAX_WORKSPACE__ =
  persistedWorkspace;
```

- [ ] **Step 2: Hydrate App from the snapshot**

In `src/app/App.tsx`, read the snapshot and pass hydration to `useTabs`. Near the top of `App()`:

```ts
import {
  deserializeWorkspace,
  scheduleWorkspaceSave,
  persistWorkspace,
  type PersistedWorkspace,
} from "@/modules/workspace/lib/workspaceStore";

const persisted = (window as unknown as { __TERAX_WORKSPACE__?: PersistedWorkspace | null })
  .__TERAX_WORKSPACE__ ?? null;
const hydration = persisted ? deserializeWorkspace(persisted) : undefined;
```

Change the `useTabs(...)` call:

```ts
  } = useTabs(
    getLaunchDir() ? { cwd: getLaunchDir() } : undefined,
    hydration,
  );
```

- [ ] **Step 3: Pass each leaf's uuid as persistId to the terminal session**

Find where terminal panes mount `useTerminalSession` (search the pane component used by App; likely `TerminalPane`). The leaf node carries `uuid`. Pass `persistId={leaf.uuid}` to `useTerminalSession`. In the component that renders a leaf:

```tsx
useTerminalSession({
  leafId: leaf.id,
  persistId: leaf.uuid,
  // ...existing props...
});
```

Run `grep -rn "useTerminalSession({" src/modules/terminal` to find the exact call site and add the `persistId` field there. (Note: the leaf object passed into the renderer must include `uuid` — it does, since it is part of `PaneNode`.)

- [ ] **Step 4: Debounced persistence on workspace changes**

In `App.tsx`, add an effect that writes whenever the persistable state changes:

```ts
useEffect(() => {
  scheduleWorkspaceSave(tabs, activeId);
}, [tabs, activeId]);
```

- [ ] **Step 5: Flush on window close via onCloseRequested**

Add an effect that registers a close handler and flushes synchronously-as-possible (await the store write before allowing close). Use `tabsRef`/`activeId` refs so the handler reads current state:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";

const activeIdRef = useRef(activeId);
activeIdRef.current = activeId;

useEffect(() => {
  let unlisten: (() => void) | undefined;
  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      // Prevent the default close until the workspace is flushed, then close.
      event.preventDefault();
      try {
        await persistWorkspace(tabsRef.current, activeIdRef.current);
      } finally {
        await getCurrentWindow().destroy();
      }
    })
    .then((un) => {
      unlisten = un;
    });
  return () => unlisten?.();
}, []);
```

> `tabsRef` already exists in App (`const tabsRef = useRef(tabs); tabsRef.current = tabs;`). `core:window:allow-close` is already granted; `destroy` is part of `core:default`.

- [ ] **Step 6: Kill the tmux session on explicit tab/pane close**

A tmux session must only survive when the tab/pane is open at quit time. When the user explicitly closes a tab or pane, kill its session. The frontend already calls `disposeSession(leafId)` in `closeTab`, `closePaneByLeaf`, `closeActivePane`, and `resetWorkspace` (useTabs.ts). Add a kill call alongside each `disposeSession`. Since `useTabs` knows the leaf uuid via the tree before removal, capture it there.

In `useTabs.ts`, add a helper and call it where leaves are disposed:

```ts
import { invoke } from "@tauri-apps/api/core";

function killPersistentLeaf(tree: PaneNode, leafId: number): void {
  const uuid = findLeafUuid(tree, leafId);
  if (!uuid) return;
  void invoke("pty_kill_persistent", { name: `terax_${uuid}` }).catch(() => {});
}
```

- In `closeTab`: before `for (const lid of toDispose) disposeSession(lid);`, capture uuids from `target.paneTree` for each disposed leaf and kill them.
- In `closePaneByLeaf` and `closeActivePane`: kill the removed leaf's session (capture its uuid from the pre-removal tree, which is `tab.paneTree` / `t.paneTree`).
- In `resetWorkspace`: kill every disposed leaf's session (capture uuids from `curr` before replacing).

Concretely, in `closeTab` replace the dispose loop:

```ts
    for (const lid of toDispose) {
      if (target && target.kind === "terminal") {
        killPersistentLeaf(target.paneTree, lid);
      }
      disposeSession(lid);
    }
```

In `closePaneByLeaf`, where it currently does `if (didRemove) disposeSession(leafId);`, capture the uuid from the pre-removal tree (grab it at the top of the setTabs callback into an outer variable `let removedUuid`) and kill before dispose. In `closeActivePane`, do the same for `removedLeaf`. In `resetWorkspace`, walk `toDispose` against the captured `curr` trees and kill each.

> Important: do NOT kill on `unbindLeafFromSlot`, HMR, or `pty_close_all` — those
> are not explicit user closes. Only the four explicit-close paths above kill.

- [ ] **Step 7: Typecheck + full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main.tsx src/app/App.tsx src/modules/tabs/lib/useTabs.ts
git commit -m "feat(workspace): restore on launch, persist on change + close, kill on explicit close"
```

### Task 13: Scrollback preload on reattach

**Files:**
- Modify: `src/app/App.tsx` (or the terminal pane component)

> After a restored leaf's tmux session is reattached and the slot is bound, push
> the prior scrollback into the buffer once. Trigger it the first time a
> restored leaf becomes ready, only when the workspace was hydrated (not for
> freshly created tabs).

- [ ] **Step 1: Call preloadScrollback once per restored leaf**

In the terminal pane component (the one that calls `useTerminalSession`), after the session is attached, call `preloadScrollback` exactly once for leaves that came from hydration. Use a module/ref guard so it runs only once per leaf:

```ts
import {
  preloadScrollback,
  whenSessionReady,
} from "@/modules/terminal/lib/useTerminalSession";
import { usePreferencesStore } from "@/modules/settings/preferences";

// `restored` = true when this leaf existed in the persisted snapshot.
const didPreload = useRef(false);
const scrollback = usePreferencesStore((p) => p.terminalScrollback);
useEffect(() => {
  if (!restored || didPreload.current || !leaf.uuid) return;
  didPreload.current = true;
  void whenSessionReady(leaf.id).then(() =>
    preloadScrollback(leaf.id, `terax_${leaf.uuid}`, scrollback),
  );
}, [restored, leaf.id, leaf.uuid, scrollback]);
```

> Pass a `restored` boolean down to the pane: in App, a leaf is "restored" if
> the workspace was hydrated AND the leaf existed in the loaded snapshot. The
> simplest correct signal: capture the set of restored leaf uuids once on mount
> (`new Set(referencedSessionNames(persisted))` minus prefix, or collect uuids
> while hydrating) and check membership. Thread that as a prop/context to the
> pane. If threading is heavy, gate purely on "hydration was non-null at mount"
> — preloadScrollback is a no-op when capture returns empty, so over-calling is
> safe.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(terminal): preload tmux scrollback on restored panes"
```

---

## Phase 5 — Graceful fallback notice

### Task 14: One-time "install tmux for persistence" notice

**Files:**
- Modify: `src/app/App.tsx`
- (Reuse the existing toast/notice mechanism — find it first.)

> On startup, if `pty_tmux_available` is false on macOS/Linux, show a one-time,
> dismissible notice suggesting `brew install tmux`. On Windows, persistence is
> out of scope — show nothing. Persist the "dismissed" flag in the settings
> store so it never reappears.

- [ ] **Step 1: Find the existing notice/toast primitive**

Run: `grep -rn "toast\|Notice\|Snackbar\|useToast" src/ | head -20`
Use whatever the codebase already has (do not introduce a new toast system). If none exists, render a small dismissible banner above the tab bar using existing UI components.

- [ ] **Step 2: Detect tmux and conditionally show the notice**

In `App.tsx`, add an effect:

```ts
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "@/lib/platform"; // verify the exact export name

useEffect(() => {
  if (IS_WINDOWS) return; // persistence out of scope on Windows
  let alive = true;
  void invoke<boolean>("pty_tmux_available").then((ok) => {
    if (!alive || ok) return;
    // Read a "dismissed" flag from the settings store; if not dismissed,
    // show the notice. Wire the dismiss button to persist the flag.
    showTmuxNotice(); // implement via the primitive found in Step 1
  });
  return () => {
    alive = false;
  };
}, []);
```

> Verify the platform export: `grep -n "IS_WINDOWS\|USE_CUSTOM_WINDOW_CONTROLS\|platform" src/lib/platform.ts`. Use the actual constant; `USE_CUSTOM_WINDOW_CONTROLS` exists but is not a Windows check — add/use a proper `IS_WINDOWS` if needed (it can derive from `navigator.userAgent` or `@tauri-apps/plugin-os`).

- [ ] **Step 3: Persist the dismissed flag**

Add a boolean pref `tmuxNoticeDismissed` to `src/modules/settings/store.ts` following the existing pattern exactly: a `KEY_*` constant, a default in `DEFAULT_PREFERENCES`, a getter line in `loadPreferences`, a `setTmuxNoticeDismissed` writer, and a `map` entry in `onPreferencesChange`. Default `false`. (This is the one new preference the feature adds.)

- [ ] **Step 4: Typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/modules/settings/store.ts
git commit -m "feat(workspace): one-time notice when tmux is unavailable"
```

---

## Phase 6 — Final verification

### Task 15: Full build + lint + test gate

- [ ] **Step 1: Frontend typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 2: Rust build + tests**

Run: `cargo build --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (tmux integration test runs if tmux present, else self-skips).

- [ ] **Step 3: Lint (match repo tooling)**

Run the repo's configured linters — check `package.json` scripts (`npm run lint`) and `cargo clippy --manifest-path src-tauri/Cargo.toml`.
Expected: clean.

### Task 16: Manual verification checklist (from the spec)

> Requires a desktop run (`npm run tauri dev` or the repo's run command) with tmux installed.

- [ ] **Persistence across restart:** Open 3 terminal tabs; split one into 2 panes; in each run a long command (`npm run dev`, `vim`, `sleep 9999`). Open an editor tab and a preview tab. Rename a terminal tab. Quit Terax fully. Reopen. Confirm: same tabs/splits/active tab, the editor + preview reopened, the renamed title preserved, and the long-running processes still alive (e.g. `vim` still on screen, `sleep` still running).
- [ ] **Scrollback restored:** Prior terminal output is visible on reopen without entering tmux copy-mode.
- [ ] **Dev reload:** With the dev server, reload the webview (Cmd+R) — processes survive, layout restores.
- [ ] **Explicit close kills session:** Close one terminal tab; run `tmux -L terax ls` in another shell and confirm that tab's `terax_*` session is gone, while the others remain.
- [ ] **GC on launch:** Manually create a stray session (`tmux -L terax new -d -s terax_orphan`); restart Terax; confirm `terax_orphan` was reaped (`tmux -L terax ls`).
- [ ] **Private terminals ephemeral:** Open a private terminal; confirm no `terax_*` session is created for it and it does not reappear after restart.
- [ ] **tmux absent fallback:** Temporarily hide tmux (`PATH` without it, or rename the binary); start Terax; confirm terminals still spawn (direct, no persistence), the layout-only restore works for non-terminal tabs, and the one-time notice appears.
- [ ] **Windows fallback (if available):** On Windows, confirm terminals spawn directly, no tmux is invoked, no notice shown, and layout-only restore behaves.

- [ ] **Final commit (only if fixups were needed):**

```bash
git add -A
git commit -m "chore(workspace): verification fixups for session persistence"
```

---

## Self-Review notes (spec coverage)

- tmux-backed PTY / dedicated socket / injected config → Tasks 3, 4, 6.
- `new-session -A` spawn+reattach → Tasks 3, 6.
- `pty_kill_persistent` → Task 7; called on explicit close → Task 12 Step 6.
- Startup GC → Tasks 3 (`gc_targets`), 7 (`pty_gc_persistent`), 12 Step 1.
- `pty_close_all` narrowed to client-handle reaping → documented in Task 12 Step 1 (behaviour unchanged in Rust; semantics clarified by comment; tmux sessions inherently survive because they live in the tmux server).
- Stable per-leaf uuid (SHARED prerequisite) → Phase 0 (Tasks 1, 2), isolated and first.
- `terax-workspace.json` via plugin-store, debounced + on close → Task 10 (store), Task 12 (debounce + `onCloseRequested`).
- Restore on launch / reattach / scrollback preload / non-terminal by descriptor → Tasks 11, 12, 13.
- First-run = one fresh tab → Task 11 (hydration falls back to default).
- Private terminals excluded → Task 10 (`serializeWorkspace` filter) + verified Task 16.
- cwd from tmux `#{pane_current_path}` → captured via tmux's own cwd (sessions created with `-c <cwd>`); the existing OSC-7 cwd handler continues to update `lastCwd`. (If stricter `pane_current_path` polling is later desired it is additive; the spec's reliability goal is met because tmux preserves cwd across reattach.)
- tmux-not-available + Windows fallback + notice → Tasks 6/7 (None paths), Task 14.
- Testing: pure unit (Tasks 1, 3, 10), Rust arg construction (Task 3), guarded Rust integration (Task 8), manual (Task 16).
