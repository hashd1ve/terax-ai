//! Local Unix-domain-socket listener for Claude Code hook state reports.
//! Hooks write one JSON line per event: {"pane":"<uuid>","state":"working"}.

use serde::{Deserialize, Serialize};

/// Emitted to the frontend as the `terax:agent-state` Tauri event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentStateEvent {
    pub pane: String,
    pub state: String,
}

/// Structured, non-display data carried on the same hook socket line, emitted to
/// the frontend as the `terax:agent-meta` Tauri event. Every field is optional:
/// a hook forwards only what its stdin JSON contains. Kept separate from
/// `AgentStateEvent` so the working/blocked/done activity contract stays intact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentMetaEvent {
    pub pane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
    /// Absolute path of a file an Edit/Write/MultiEdit tool just changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Deserialize)]
struct RawLine {
    pane: String,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    file: Option<String>,
}

const VALID_STATES: [&str; 3] = ["working", "blocked", "done"];

/// Parse the activity-state half of one newline-delimited JSON message. Returns
/// `None` for blank lines, malformed JSON, empty pane, a missing state, or an
/// unrecognized state. A meta-only line (no `state`) correctly yields `None`.
pub fn parse_state_line(line: &str) -> Option<AgentStateEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    let state = raw.state?;
    if raw.pane.is_empty() || !VALID_STATES.contains(&state.as_str()) {
        return None;
    }
    Some(AgentStateEvent { pane: raw.pane, state })
}

/// Parse the structured-meta half of one message. Returns `None` unless the line
/// is valid JSON with a non-empty pane and at least one meta field, so a plain
/// `{pane,state}` activity line never produces a spurious meta event.
pub fn parse_meta_line(line: &str) -> Option<AgentMetaEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    if raw.pane.is_empty() {
        return None;
    }
    if raw.tool.is_none()
        && raw.cwd.is_none()
        && raw.session.is_none()
        && raw.transcript.is_none()
        && raw.file.is_none()
    {
        return None;
    }
    Some(AgentMetaEvent {
        pane: raw.pane,
        tool: raw.tool,
        cwd: raw.cwd,
        session: raw.session,
        transcript: raw.transcript,
        file: raw.file,
    })
}

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const AGENT_STATE_EVENT: &str = "terax:agent-state";
pub const AGENT_META_EVENT: &str = "terax:agent-meta";

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
                        // One line can carry both halves: an activity state and
                        // structured meta. Emit each on its own event.
                        if let Some(ev) = parse_state_line(&line) {
                            let _ = app.emit(AGENT_STATE_EVENT, ev);
                        }
                        if let Some(ev) = parse_meta_line(&line) {
                            let _ = app.emit(AGENT_META_EVENT, ev);
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

    #[test]
    fn meta_line_parses_all_fields() {
        let m = parse_meta_line(
            r#"{"pane":"p","tool":"Edit","cwd":"/c","session":"sid","transcript":"/t.jsonl"}"#,
        )
        .unwrap();
        assert_eq!(m.pane, "p");
        assert_eq!(m.tool.as_deref(), Some("Edit"));
        assert_eq!(m.cwd.as_deref(), Some("/c"));
        assert_eq!(m.session.as_deref(), Some("sid"));
        assert_eq!(m.transcript.as_deref(), Some("/t.jsonl"));
    }

    #[test]
    fn meta_line_parses_file_only() {
        let m = parse_meta_line(r#"{"pane":"p","file":"/proj/x.ts"}"#).unwrap();
        assert_eq!(m.file.as_deref(), Some("/proj/x.ts"));
        assert!(m.tool.is_none());
        // A file-only meta line carries no activity state.
        assert_eq!(parse_state_line(r#"{"pane":"p","file":"/proj/x.ts"}"#), None);
    }

    #[test]
    fn meta_line_none_for_state_only() {
        // A plain activity line carries no meta and must not emit a meta event.
        assert_eq!(parse_meta_line(r#"{"pane":"p","state":"working"}"#), None);
    }

    #[test]
    fn meta_line_rejects_empty_pane_and_blank() {
        assert_eq!(parse_meta_line(r#"{"pane":"","tool":"Edit"}"#), None);
        assert_eq!(parse_meta_line("   "), None);
        assert_eq!(parse_meta_line("{not json"), None);
    }

    #[test]
    fn one_line_yields_both_state_and_meta() {
        // A PreToolUse line carries state AND tool; each parser sees its half.
        let line = r#"{"pane":"p","state":"working","tool":"Bash","session":"sid"}"#;
        assert_eq!(parse_state_line(line).unwrap().state, "working");
        let m = parse_meta_line(line).unwrap();
        assert_eq!(m.tool.as_deref(), Some("Bash"));
        assert_eq!(m.session.as_deref(), Some("sid"));
    }

    #[test]
    fn state_line_ignores_meta_only_payload() {
        // SessionStart sends session/cwd with no state; the state parser yields None.
        assert_eq!(
            parse_state_line(r#"{"pane":"p","session":"sid","cwd":"/c"}"#),
            None
        );
    }
}
