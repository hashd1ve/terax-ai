use serde::{Deserialize, Serialize};

// Mirrors ~/.claude/sessions/<pid>.json. Optional fields carry #[serde(default)]
// so a registry written by an older/newer CLI never breaks the whole listing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSession {
    pid: i32,
    session_id: String,
    cwd: String,
    status: String,
    updated_at: i64,
    #[serde(default)]
    name: Option<String>,
}

// camelCase Serialize struct handed to the webview. `live` is computed host-side
// (status/updatedAt in the file are stale and are not a liveness signal).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub session_id: String,
    pub pid: i32,
    pub cwd: String,
    pub status: String,
    pub updated_at: i64,
    pub name: Option<String>,
    pub live: bool,
}

fn parse_session(json: &str) -> Option<RawSession> {
    serde_json::from_str::<RawSession>(json).ok()
}

#[cfg(unix)]
fn pid_is_live(pid: i32) -> bool {
    // kill(pid, 0) probes existence without delivering a signal. A live process
    // we own returns 0; a stale pid returns -1 (ESRCH). pid 0 means the whole
    // process group on Unix, never a session, so reject it.
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

#[cfg(not(unix))]
fn pid_is_live(_pid: i32) -> bool {
    // Windows has no kill(pid, 0) here; mirror agent_sock's no-op precedent and
    // degrade gracefully rather than enumerate processes.
    true
}

fn into_session(raw: RawSession) -> ClaudeSession {
    let live = pid_is_live(raw.pid);
    ClaudeSession {
        session_id: raw.session_id,
        pid: raw.pid,
        cwd: raw.cwd,
        status: raw.status,
        updated_at: raw.updated_at,
        name: raw.name,
        live,
    }
}

#[tauri::command]
pub fn claude_sessions_list() -> Result<Vec<ClaudeSession>, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("sessions");

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        // No registry yet (Claude Code never run) is an empty list, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };

    let mut out: Vec<ClaudeSession> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read_to_string(&p).ok())
        .filter_map(|s| parse_session(&s))
        .map(into_session)
        .collect();

    // Live first, then most-recently-updated first within each group.
    out.sort_by(|a, b| {
        b.live
            .cmp(&a.live)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"{
        "pid": 15401,
        "sessionId": "479f2344-6354-415c-815f-14bff29ecac0",
        "cwd": "/Users/me/proj",
        "startedAt": 1780005566330,
        "procStart": "Thu May 28 21:59:25 2026",
        "version": "2.1.156",
        "peerProtocol": 1,
        "kind": "interactive",
        "entrypoint": "cli",
        "status": "busy",
        "updatedAt": 1780009425731,
        "name": "heuristics",
        "bridgeSessionId": "session_01Kx"
    }"#;

    #[test]
    fn parses_full_session() {
        let s = parse_session(FULL).expect("full session parses");
        assert_eq!(s.pid, 15401);
        assert_eq!(s.session_id, "479f2344-6354-415c-815f-14bff29ecac0");
        assert_eq!(s.cwd, "/Users/me/proj");
        assert_eq!(s.status, "busy");
        assert_eq!(s.updated_at, 1780009425731);
        assert_eq!(s.name.as_deref(), Some("heuristics"));
    }

    #[test]
    fn missing_optional_name_still_parses() {
        let json = r#"{
            "pid": 10172,
            "sessionId": "e5fd3831-a672-49e1-850c-8f57c7617a6b",
            "cwd": "/Users/me/glassnode",
            "status": "idle",
            "updatedAt": 1779897262865
        }"#;
        let s = parse_session(json).expect("session without name parses");
        assert_eq!(s.pid, 10172);
        assert_eq!(s.name, None);
    }

    #[test]
    fn malformed_json_is_none() {
        assert!(parse_session("{ not json,").is_none());
        // Right shape, wrong type on a required field.
        assert!(parse_session(r#"{"pid":"x","sessionId":"a","cwd":"/","status":"idle","updatedAt":1}"#).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn pid_liveness_reflects_real_processes() {
        assert!(pid_is_live(std::process::id() as i32));
        assert!(!pid_is_live(0));
        assert!(!pid_is_live(-1));
        // An absurd pid that cannot be running.
        assert!(!pid_is_live(i32::MAX));
    }
}
