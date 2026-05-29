use serde_json::{json, Value};

// (claude event, notify-bell OSC marker, activity-indicator state).
// A `None` marker installs no notification-bell sequence; a `None` state sends
// no activity state, used for meta-only events (SessionStart/SessionEnd) that
// must carry session/transcript data without flapping the working/blocked/done
// indicator.
const HOOK_EVENTS: [(&str, Option<&str>, Option<&str>); 10] = [
    ("UserPromptSubmit", Some("working"), Some("working")),
    ("PreToolUse", Some("working"), Some("working")),
    ("Notification", Some("attention"), Some("blocked")),
    ("Stop", Some("finished"), Some("done")),
    ("SubagentStop", Some("finished"), Some("done")),
    ("SessionStart", None, None),
    ("SessionEnd", None, None),
    // After a tool runs: meta-only (no bell, no state flap, PreToolUse already
    // set working) to carry the edited file_path for the Edit Inbox.
    ("PostToolUse", None, None),
    // A failed tool call: bell-only (no socket state) so it lands in history as
    // "failed" without flapping the working/blocked/done indicator.
    ("PostToolUseFailure", Some("error"), None),
    // Blocked waiting for the user to allow/deny a tool: the actionable case,
    // routed like attention (toast when hidden, OS-notify when unfocused).
    ("PermissionRequest", Some("attention"), Some("blocked")),
];

// A command is ours if it carries one of these. "notify;Terax;" tags the
// bell-bearing hooks; "TERAX_AGENT_SOCK" tags every socket-reporting hook
// (including meta-only ones that have no bell marker); "terax;notify" is the
// pre-v2.1.139 /dev/tty variant kept so re-running migrates it.
const OWNED_MARKERS: [&str; 3] = ["notify;Terax;", "TERAX_AGENT_SOCK", "terax;notify"];

// Up to two best-effort effects per fire, merged into one settings.json command:
//   1) When `marker` is set: an OSC 777 sequence via Claude's `terminalSequence`
//      field (drives the notification bell), gated on TERAX_TERMINAL. Uses
//      terminalSequence because hooks lost /dev/tty access in v2.1.139.
//   2) A structured JSON line to the per-pane activity socket: always the pane,
//      the `state` when set, plus tool_name/cwd/session_id/transcript_path read
//      from the hook's stdin JSON (Claude passes hook input on stdin). A
//      missing/closed socket, absent python3, or a tty stdin is a silent no-op
//      and never blocks the agent.
fn hook_cmd(marker: Option<&str>, state: Option<&str>) -> String {
    let bell = match marker {
        Some(m) => format!(
            r#"[ -n "$TERAX_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Terax;{m}\\u0007"}}' ; "#
        ),
        None => String::new(),
    };
    let set_state = match state {
        Some(s) => format!(r#"m["state"]="{s}";"#),
        None => String::new(),
    };
    let py = format!(
        r#"import socket,sys,json,os
try:
 d=json.loads(sys.stdin.read() or "{{}}") if not sys.stdin.isatty() else {{}}
except Exception:
 d={{}}
m={{"pane":os.environ["TERAX_PANE"]}};{set_state}
for k,src in (("tool","tool_name"),("cwd","cwd"),("session","session_id"),("transcript","transcript_path")):
 v=d.get(src)
 if v: m[k]=v
ti=d.get("tool_input")
if isinstance(ti,dict) and ti.get("file_path"): m["file"]=ti["file_path"]
try:
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(0.2);s.connect(os.environ["TERAX_AGENT_SOCK"]);s.sendall((json.dumps(m)+"\n").encode());s.close()
except OSError: pass"#
    );
    format!(
        r#"{bell}[ -n "$TERAX_PANE" ] && [ -n "$TERAX_AGENT_SOCK" ] && python3 -c '{py}' 2>/dev/null ; true"#
    )
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, marker, state) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": hook_cmd(marker, state) } ]
        }));
    }
    root
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!("{} is not valid JSON ({e}); refusing to overwrite", path.display())
        }),
        _ => Ok(json!({})),
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("settings.json"))
}

#[tauri::command]
pub fn agent_enable_claude_hooks() -> Result<(), String> {
    let path = settings_path()?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };

    let merged = merge_hooks(existing);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;

    // Write to a sibling temp file then rename so a crash mid-write can't leave
    // a truncated settings.json.
    let tmp = path.with_extension("json.terax-tmp");
    std::fs::write(&tmp, out).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub fn agent_claude_hooks_status() -> bool {
    let Some(content) = settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    HOOK_EVENTS
        .iter()
        .filter_map(|(_, m, _)| *m)
        .all(|m| content.contains(&format!("notify;Terax;{m}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
        assert!(command(&out, "Stop", 0).contains("notify;Terax;finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn adds_pretooluse_and_subagentstop_events() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "PreToolUse"), 1);
        assert_eq!(hook_count(&out, "SubagentStop"), 1);
        assert!(command(&out, "PreToolUse", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains(r#"m["state"]="done""#));
        assert!(command(&out, "Notification", 0).contains(r#"m["state"]="blocked""#));
        assert!(command(&out, "UserPromptSubmit", 0).contains("TERAX_AGENT_SOCK"));
    }

    #[test]
    fn enriches_socket_payload_from_hook_stdin() {
        let out = merge_hooks(json!({}));
        let cmd = command(&out, "PreToolUse", 0);
        // The python one-liner reads the hook JSON on stdin and forwards meta.
        assert!(cmd.contains("sys.stdin"));
        assert!(cmd.contains("json.loads"));
        assert!(cmd.contains("tool_name"));
        assert!(cmd.contains("session_id"));
        assert!(cmd.contains("transcript_path"));
        assert!(cmd.contains("tool_input"));
        assert!(cmd.contains("file_path"));
    }

    #[test]
    fn installs_meta_only_session_events_without_bell_or_state() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "SessionStart"), 1);
        assert_eq!(hook_count(&out, "SessionEnd"), 1);
        let start = command(&out, "SessionStart", 0);
        // Meta-only: carries the socket reporter but no bell marker and no state.
        assert!(start.contains("TERAX_AGENT_SOCK"));
        assert!(start.contains("session_id"));
        assert!(!start.contains("notify;Terax;"));
        assert!(!start.contains(r#"m["state"]"#));
    }

    #[test]
    fn installs_failure_and_permission_events() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "PostToolUseFailure"), 1);
        assert_eq!(hook_count(&out, "PermissionRequest"), 1);
        // Failure is bell-only: error marker, no socket activity state.
        let fail = command(&out, "PostToolUseFailure", 0);
        assert!(fail.contains("notify;Terax;error"));
        assert!(!fail.contains(r#"m["state"]"#));
        // Permission is the actionable case: attention bell + blocked indicator.
        let perm = command(&out, "PermissionRequest", 0);
        assert!(perm.contains("notify;Terax;attention"));
        assert!(perm.contains(r#"m["state"]="blocked""#));
    }

    #[test]
    fn status_ignores_meta_only_events() {
        // SessionStart/SessionEnd carry no bell marker, so the status check must
        // not require them. A config with only the bell-bearing markers passes.
        let out = merge_hooks(json!({}));
        let serialized = serde_json::to_string(&out).unwrap();
        for m in ["working", "attention", "finished"] {
            assert!(serialized.contains(&format!("notify;Terax;{m}")));
        }
    }

    #[test]
    fn is_idempotent() {
        let once = merge_hooks(json!({}));
        let twice = merge_hooks(once.clone());
        assert_eq!(once, twice);
        assert_eq!(hook_count(&twice, "Notification"), 1);
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$TERAX_TERMINAL\" ] && printf '\\033]777;terax;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terminalSequence"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"));
        assert_eq!(hook_count(&out, "Notification"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_cmd(Some("attention"), Some("blocked")) } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }

    // Extract the python body between `python3 -c '` and `' 2>/dev/null`.
    // Safe because the generated body contains no single quotes.
    fn extract_python(cmd: &str) -> String {
        let open = "python3 -c '";
        let start = cmd.find(open).expect("python invocation") + open.len();
        let rest = &cmd[start..];
        let end = rest.find("' 2>/dev/null").expect("python terminator");
        rest[..end].to_string()
    }

    // Runs the generated python with a sample hook JSON on stdin and a real
    // listening socket, asserting the emitted line carries both the activity
    // state and the structured meta. Locks the shell/python/Rust escaping, the
    // riskiest part of the channel. Gated: skipped if python3 is unavailable.
    #[cfg(unix)]
    #[test]
    fn hook_python_forwards_state_and_meta_over_socket() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::{AtomicU32, Ordering};

        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }

        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let sock = std::env::temp_dir().join(format!("terax-hook-{}-{n}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();

        let py = extract_python(&hook_cmd(Some("working"), Some("working")));
        let mut child = std::process::Command::new("python3")
            .arg("-c")
            .arg(&py)
            .env("TERAX_PANE", "pane-1")
            .env("TERAX_AGENT_SOCK", &sock)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                br#"{"tool_name":"Edit","session_id":"sid","transcript_path":"/t.jsonl","cwd":"/proj","tool_input":{"file_path":"/proj/x.ts"}}"#,
            )
            .unwrap();

        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        let _ = child.wait();
        let _ = std::fs::remove_file(&sock);

        let line = buf.trim();
        let state =
            crate::modules::agent_sock::parse_state_line(line).expect("valid state line");
        assert_eq!(state.state, "working");
        assert_eq!(state.pane, "pane-1");
        let meta =
            crate::modules::agent_sock::parse_meta_line(line).expect("valid meta line");
        assert_eq!(meta.tool.as_deref(), Some("Edit"));
        assert_eq!(meta.session.as_deref(), Some("sid"));
        assert_eq!(meta.transcript.as_deref(), Some("/t.jsonl"));
        assert_eq!(meta.cwd.as_deref(), Some("/proj"));
        assert_eq!(meta.file.as_deref(), Some("/proj/x.ts"));
    }
}
