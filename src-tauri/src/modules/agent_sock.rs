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
