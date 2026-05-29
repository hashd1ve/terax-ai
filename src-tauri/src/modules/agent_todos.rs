use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One row of Claude Code's TodoWrite list, as persisted to
/// ~/.claude/todos/<sessionId>-agent-<agentId>.json (a JSON array of these).
/// `status` is one of "pending" | "in_progress" | "completed"; `activeForm` is
/// the present-tense label Claude shows while the item is in progress.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    #[serde(default)]
    pub active_form: Option<String>,
}

/// Lenient parse: the file is owned by another process and may be mid-write or
/// from a newer CLI, so any failure degrades to an empty plan rather than an
/// error the panel would have to special-case.
pub fn parse_todos(json: &str) -> Vec<TodoItem> {
    serde_json::from_str::<Vec<TodoItem>>(json).unwrap_or_default()
}

/// A session id is the only attacker-influenced input and is interpolated into a
/// file-name prefix, so it must be a bare token: ASCII alphanumerics and `-`
/// only. This rejects empty, `.`/`..`, and any separator before it touches the
/// filesystem, so no input can escape ~/.claude/todos.
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// True when `file_name` is a todos file belonging to `session_id`: it starts
/// with the id and ends with `.json`. The on-disk name carries an
/// `-agent-<agentId>` suffix the host never learns, hence the prefix match.
fn matches_session(file_name: &str, session_id: &str) -> bool {
    file_name.starts_with(session_id) && file_name.ends_with(".json")
}

const MAX_TODOS_BYTES: u64 = 512 * 1024;

/// Newest-mtime todos file for this session under `dir`, or None when the dir is
/// missing or holds no match. Kept pure over a directory path so the matcher and
/// the recency rule are unit-testable without the home-dir lookup.
fn newest_session_file(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !matches_session(name, session_id) {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        match &best {
            Some((best_mtime, _)) if *best_mtime >= mtime => {}
            _ => best = Some((mtime, path)),
        }
    }
    best.map(|(_, path)| path)
}

#[tauri::command]
pub fn agent_read_todos(session_id: String) -> Result<Vec<TodoItem>, String> {
    if !is_valid_session_id(&session_id) {
        return Err("invalid session id".to_string());
    }
    let dir = dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("todos");

    let Some(path) = newest_session_file(&dir, &session_id) else {
        return Ok(Vec::new());
    };

    match std::fs::metadata(&path) {
        Ok(m) if m.len() > MAX_TODOS_BYTES => return Ok(Vec::new()),
        Ok(_) => {}
        Err(_) => return Ok(Vec::new()),
    }

    match std::fs::read_to_string(&path) {
        Ok(json) => Ok(parse_todos(&json)),
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    const FIXTURE: &str = r#"[
        {"content": "Read TERAX.md and verify ground truth", "status": "completed", "activeForm": "Reading TERAX.md"},
        {"content": "Implement agent_read_todos command", "status": "in_progress", "activeForm": "Implementing agent_read_todos"},
        {"content": "Wire the sidebar panel", "status": "pending", "activeForm": "Wiring the sidebar panel"}
    ]"#;

    #[test]
    fn parses_realistic_fixture() {
        let items = parse_todos(FIXTURE);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].status, "completed");
        assert_eq!(items[0].content, "Read TERAX.md and verify ground truth");
        assert_eq!(items[1].status, "in_progress");
        assert_eq!(
            items[1].active_form.as_deref(),
            Some("Implementing agent_read_todos")
        );
        assert_eq!(items[2].status, "pending");
    }

    #[test]
    fn missing_active_form_still_parses() {
        let items = parse_todos(r#"[{"content": "ship it", "status": "pending"}]"#);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].active_form, None);
    }

    #[test]
    fn malformed_json_is_empty() {
        assert!(parse_todos("[ not json,").is_empty());
        assert!(parse_todos("{}").is_empty());
        assert!(parse_todos("").is_empty());
    }

    #[test]
    fn rejects_path_traversal_session_ids() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id(".."));
        assert!(!is_valid_session_id("../etc"));
        assert!(!is_valid_session_id("a/b"));
        assert!(!is_valid_session_id("a\\b"));
        assert!(!is_valid_session_id("a.json"));
        assert!(!is_valid_session_id("a b"));
    }

    #[test]
    fn accepts_real_session_ids() {
        assert!(is_valid_session_id("479f2344-6354-415c-815f-14bff29ecac0"));
        assert!(is_valid_session_id("abc123"));
    }

    #[test]
    fn invalid_session_id_is_rejected_by_command() {
        assert!(agent_read_todos("../secrets".to_string()).is_err());
        assert!(agent_read_todos(String::new()).is_err());
    }

    #[test]
    fn matches_session_requires_prefix_and_json() {
        let id = "479f2344-6354-415c-815f-14bff29ecac0";
        assert!(matches_session(&format!("{id}-agent-abc.json"), id));
        assert!(matches_session(&format!("{id}.json"), id));
        assert!(!matches_session(&format!("{id}-agent-abc.txt"), id));
        assert!(!matches_session("other-session-agent-abc.json", id));
    }

    #[test]
    fn newest_session_file_picks_most_recent_match() {
        let dir = std::env::temp_dir().join(format!("terax-todos-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let id = "sess-abc";

        let old = dir.join(format!("{id}-agent-1.json"));
        fs::write(&old, "[]").unwrap();
        // A different session must never be selected for `id`.
        fs::write(dir.join("other-agent-1.json"), "[]").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let new = dir.join(format!("{id}-agent-2.json"));
        fs::write(&new, "[]").unwrap();

        let picked = newest_session_file(&dir, id).expect("a match exists");
        assert_eq!(picked, new);

        // Missing dir -> None, never an error.
        let _ = fs::remove_dir_all(&dir);
        assert!(newest_session_file(&dir, id).is_none());
    }
}
