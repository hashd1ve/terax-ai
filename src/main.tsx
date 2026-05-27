import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import {
  loadWorkspace,
  referencedSessionNames,
} from "./modules/workspace/lib/workspaceStore";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Reap PTY *client* handles orphaned by a prior webview load before any tab
// spawns. tmux sessions (when used) survive this — they live in the tmux
// server, not the app process.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

// Load persisted workspace and GC orphan tmux sessions (any terax_* not
// referenced by the snapshot). Pass the snapshot to App via a window global
// the App reads on mount (avoids prop drilling through createRoot).
const persistedWorkspace = await loadWorkspace().catch(() => null);
await invoke("pty_gc_persistent", {
  referenced: persistedWorkspace
    ? referencedSessionNames(persistedWorkspace)
    : [],
}).catch(() => {});

(window as unknown as { __TERAX_WORKSPACE__?: unknown }).__TERAX_WORKSPACE__ =
  persistedWorkspace;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
