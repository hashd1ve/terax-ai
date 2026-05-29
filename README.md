<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>

  <p><strong>Lightweight, terminal-first dev workspace with first-class Claude Code integration.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
  </p>
</div>

---

Terax is a lightweight, open-source, terminal-first dev workspace built on Tauri 2 + Rust and React 19. A native PTY backend with a WebGL renderer, a code editor, file explorer, source control with a git graph, and a web preview pane, plus first-class Claude Code integration: run Claude Code in the terminal with native notifications and activity tracking. About 7-8 MB on disk. No telemetry. No account.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/terminal.png" alt="Terminal" /><br/><sub>Multi-tab terminal with WebGL rendering</sub></td>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" /><br/><sub>Custom themes, presets, and background images</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="docs/source-control.png" alt="Source control and git graph" /><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
</table>

## Features

### Terminal

- xterm.js with WebGL renderer, multi-tab with background streaming
- Native PTY backend via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Per-tab workspace environments on Windows (Local, or any installed WSL distro)

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Vim mode
- Ten built-in editor themes: Atom One, Aura, Copilot, GitHub Dark / Light, Gruvbox Dark, Nord, Tokyo Night, Xcode Dark / Light

### Source control

- Stage / unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push with upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions

### Web preview

- Auto-detects local dev servers and opens them in a preview tab
- External URL preview via a native child webview

### Themes and customization

- Custom themes built in-app, switch between bundled presets and your own
- Create your own themes, share them or import from the community
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### Claude Code integration

Terax is a host for Claude Code in the terminal. It makes no model calls of its own; it observes the agent (via Claude Code hooks and the session transcript) and feeds the focused pane.

- Detects when Claude Code is running in the terminal, with per-tab activity indicators (working / waiting / failed) and native + in-app notifications when it needs input, finishes, or a tool fails
- Session switcher: see every Claude Code session, jump to a running one, or resume a dead one in a click
- Send to Claude: hand a file (from the explorer) or an editor selection to the focused agent as an `@path#L10-20` reference, without retyping paths
- Edit inbox: each tab shows the files the agent just changed and opens them in the editor with one click
- Plan panel: the agent's live to-do checklist in the sidebar
- Per-pane HUD: context-window usage, model, tokens, and an estimated cost, read-only from the transcript (no changes to your Claude config)
- Agent dashboard: one mission-control view of every running agent across panes
- Quick-prompt palette: fuzzy palette of reusable prompts and your `.claude` slash-commands, typed straight into the pane

These features cost nothing when no agent is running. Enable the hooks from the notification bell.

## Install

Build from source — see [Build from source](#build-from-source) below.

### Windows notes

- On first launch Windows shows "Windows protected your PC" because Terax isn't code-signed yet (will be fixed soon). Click **More info** then **Run anyway**.
- Default shell detection: `pwsh.exe` (PowerShell 7+) -> `powershell.exe` (Windows PowerShell 5.1), -> `cmd.exe`.
- WSL is a first-class workspace environment, not a wrapped subprocess.

### Linux notes

- **Arch / AUR:** `yay -S terax-bin` (or `paru`, etc.). Tracks the latest release.
- **AppImage:** needs FUSE. Without it: `./Terax_*.AppImage --appimage-extract-and-run`. On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Otherwise the `.deb` / `.rpm` packages link against the system GTK stack and tend to be smoother.

## Build from source

**Prerequisites**
- Rust (stable), https://rustup.rs
- Node 20+ and [pnpm](https://pnpm.io)
- Tauri prerequisites for your platform, https://tauri.app/start/prerequisites/

**Run**
```bash
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production bundle
```

**Checks**
```bash
pnpm exec tsc --noEmit          # frontend type-check
cd src-tauri && cargo clippy    # Rust lint
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, xterm.js, CodeMirror 6, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome! Feel free to open issues, suggest features, or submit pull requests.

## License

Terax is licensed under the Apache-2.0 License. For more information on our dependencies, see [Apache License 2.0](LICENSE).
