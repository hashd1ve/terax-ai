mod agent_detect;
mod da_filter;
#[cfg(windows)]
mod job;
mod session;
pub(crate) mod shell_init;
pub(crate) mod tmux;
pub(crate) mod tmux_panes;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    persist_id: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
        log::warn!("pty_open: cwd rejected: {e}");
        e
    })?;
    let tmux_launch = build_tmux_launch(persist_id.as_deref(), cwd.as_deref(), cols, rows);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, app, cols, rows, cwd, workspace, tmux_launch, on_data, on_exit)
            .map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

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

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

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
    let live: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
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
