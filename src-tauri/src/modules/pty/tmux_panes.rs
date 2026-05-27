//! Batched tmux foreground-process polling for the activity heuristic.

/// One pane reading: leaf uuid, foreground command basename, and the pane's
/// current working directory (used to keep the tab label in sync with `cd`,
/// since tmux swallows the shell's OSC 7 and never forwards it to Terax).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PaneForeground {
    pub uuid: String,
    pub command: String,
    pub path: String,
}

/// Parse the output of `tmux -L terax list-panes -a -F
/// '#{session_name} #{pane_current_command} #{pane_current_path}'`.
/// Only `terax_<uuid>` sessions are kept; the `terax_` prefix is stripped.
/// The path is the remainder of the line (it may legitimately contain spaces),
/// so we split into at most three fields and never beyond the command token.
pub fn parse_list_panes(stdout: &str) -> Vec<PaneForeground> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.trim_start().splitn(3, ' ');
        let session = parts.next().unwrap_or("");
        let command = parts.next().unwrap_or("").trim();
        let path = parts.next().unwrap_or("").trim();
        let Some(uuid) = session.strip_prefix("terax_") else {
            continue;
        };
        if uuid.is_empty() {
            continue;
        }
        out.push(PaneForeground {
            uuid: uuid.to_string(),
            command: command.to_string(),
            path: path.to_string(),
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
            "#{session_name} #{pane_current_command} #{pane_current_path}",
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
    fn parses_session_command_and_path() {
        let out = parse_list_panes(
            "terax_abc-123 zsh /Users/me\nterax_def-456 node /Users/me/proj\n",
        );
        assert_eq!(
            out,
            vec![
                PaneForeground {
                    uuid: "abc-123".into(),
                    command: "zsh".into(),
                    path: "/Users/me".into()
                },
                PaneForeground {
                    uuid: "def-456".into(),
                    command: "node".into(),
                    path: "/Users/me/proj".into()
                },
            ]
        );
    }

    #[test]
    fn ignores_non_terax_sessions() {
        let out = parse_list_panes("work bash /tmp\nterax_x npm /srv\n");
        assert_eq!(
            out,
            vec![PaneForeground { uuid: "x".into(), command: "npm".into(), path: "/srv".into() }]
        );
    }

    #[test]
    fn path_may_contain_spaces() {
        let out = parse_list_panes("terax_z zsh /Users/me/My Project\n");
        assert_eq!(
            out,
            vec![PaneForeground {
                uuid: "z".into(),
                command: "zsh".into(),
                path: "/Users/me/My Project".into()
            }]
        );
    }

    #[test]
    fn handles_missing_path_and_blank_lines() {
        let out = parse_list_panes("terax_y zsh\n\n  \nterax_w cargo \n");
        assert_eq!(
            out,
            vec![
                PaneForeground { uuid: "y".into(), command: "zsh".into(), path: "".into() },
                PaneForeground { uuid: "w".into(), command: "cargo".into(), path: "".into() },
            ]
        );
    }

    #[test]
    fn handles_empty_command_with_path() {
        // tmux emits two spaces when pane_current_command expands to nothing.
        let out = parse_list_panes("terax_v  /only/path\n");
        assert_eq!(
            out,
            vec![PaneForeground { uuid: "v".into(), command: "".into(), path: "/only/path".into() }]
        );
    }

    #[test]
    fn ignores_empty_uuid() {
        assert!(parse_list_panes("terax_ zsh /x\n").is_empty());
    }
}
