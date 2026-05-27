//! Batched tmux foreground-process polling for the activity heuristic.

/// One foreground reading: (leaf uuid, foreground command basename).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PaneForeground {
    pub uuid: String,
    pub command: String,
}

/// Parse the output of
/// `tmux -L terax list-panes -a -F '#{session_name} #{pane_current_command}'`.
/// Only `terax_<uuid>` sessions are kept; the `terax_` prefix is stripped.
pub fn parse_list_panes(stdout: &str) -> Vec<PaneForeground> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (session, command) = match line.split_once(' ') {
            Some((s, c)) => (s, c.trim()),
            None => (line, ""),
        };
        let Some(uuid) = session.strip_prefix("terax_") else {
            continue;
        };
        if uuid.is_empty() {
            continue;
        }
        out.push(PaneForeground {
            uuid: uuid.to_string(),
            command: command.to_string(),
        });
    }
    out
}

use std::process::Command;

/// Batched foreground poll. Returns `[]` if tmux is unavailable so the
/// frontend heuristic falls back to output-activity only.
#[tauri::command]
pub fn tmux_list_panes() -> Vec<PaneForeground> {
    let output = Command::new("tmux")
        .args([
            "-L",
            "terax",
            "list-panes",
            "-a",
            "-F",
            "#{session_name} #{pane_current_command}",
        ])
        .output();
    match output {
        Ok(o) if o.status.success() => parse_list_panes(&String::from_utf8_lossy(&o.stdout)),
        Ok(_) => Vec::new(), // tmux ran but no server/sessions
        Err(e) => {
            log::debug!("tmux_list_panes: tmux unavailable: {e}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_and_command() {
        let out = parse_list_panes("terax_abc-123 zsh\nterax_def-456 claude\n");
        assert_eq!(
            out,
            vec![
                PaneForeground { uuid: "abc-123".into(), command: "zsh".into() },
                PaneForeground { uuid: "def-456".into(), command: "claude".into() },
            ]
        );
    }

    #[test]
    fn ignores_non_terax_sessions() {
        let out = parse_list_panes("work bash\nterax_x npm\n");
        assert_eq!(out, vec![PaneForeground { uuid: "x".into(), command: "npm".into() }]);
    }

    #[test]
    fn handles_missing_command_and_blank_lines() {
        let out = parse_list_panes("terax_y\n\n  \nterax_z  cargo  \n");
        assert_eq!(
            out,
            vec![
                PaneForeground { uuid: "y".into(), command: "".into() },
                PaneForeground { uuid: "z".into(), command: "cargo".into() },
            ]
        );
    }

    #[test]
    fn ignores_empty_uuid() {
        assert!(parse_list_panes("terax_ zsh\n").is_empty());
    }
}
