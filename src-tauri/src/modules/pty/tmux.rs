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
        "-L".into(),
        SOCKET.into(),
        "-f".into(),
        config_path.into(),
        "new-session".into(),
        "-A".into(),
        "-s".into(),
        name.into(),
        "-x".into(),
        cols.to_string(),
        "-y".into(),
        rows.to_string(),
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
    vec![
        "-L".into(),
        SOCKET.into(),
        "kill-session".into(),
        "-t".into(),
        name.into(),
    ]
}

/// `tmux -L terax list-sessions -F '#{session_name}'` — used by GC.
pub fn list_sessions_args() -> Vec<String> {
    vec![
        "-L".into(),
        SOCKET.into(),
        "list-sessions".into(),
        "-F".into(),
        "#{session_name}".into(),
    ]
}

/// `tmux -L terax capture-pane -p -t <name> -S -<lines>` — last `lines` of
/// scrollback as plain text, for preload into xterm on reattach.
pub fn capture_pane_args(name: &str, lines: u32) -> Vec<String> {
    vec![
        "-L".into(),
        SOCKET.into(),
        "capture-pane".into(),
        "-p".into(),
        "-t".into(),
        name.into(),
        "-S".into(),
        format!("-{lines}"),
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
                "-L",
                "terax",
                "-f",
                "/cfg/tmux.conf",
                "new-session",
                "-A",
                "-s",
                "terax_x",
                "-x",
                "120",
                "-y",
                "40",
                "-c",
                "/home/u/proj",
                "--",
                "/bin/zsh",
                "-l",
            ]
        );
    }

    #[test]
    fn new_session_omits_cwd_and_argv_when_absent() {
        let args = new_session_args("/cfg/tmux.conf", "terax_x", 80, 24, None, &[]);
        assert_eq!(
            args,
            vec![
                "-L",
                "terax",
                "-f",
                "/cfg/tmux.conf",
                "new-session",
                "-A",
                "-s",
                "terax_x",
                "-x",
                "80",
                "-y",
                "24",
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
        let live = vec!["terax_a".into(), "terax_b".into(), "user_shell".into()];
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
