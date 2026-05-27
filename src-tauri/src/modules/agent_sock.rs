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

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const AGENT_STATE_EVENT: &str = "terax:agent-state";

/// Managed so `pty_open` can read the socket path to inject into the child env.
pub struct AgentSockPath(pub PathBuf);

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
