import type { Tab } from "./useTabs";

/** Parent directory of a path, handling both POSIX and Windows separators.
 *  Falls back to the path itself when it has no separator. */
function dirname(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return path;
  return parts.slice(0, -1).join("/");
}

/** The folder a tab is associated with, or null when it has none (preview). */
export function folderForTab(tab: Tab): string | null {
  switch (tab.kind) {
    case "terminal":
      return tab.cwd ?? null;
    case "editor":
    case "markdown":
    case "html-preview":
      return dirname(tab.path);
    case "git-diff":
    case "git-history":
    case "git-commit-file":
      return tab.repoRoot;
    case "preview":
    case "agent-dashboard":
      return null;
  }
}

/** Deterministic hash of a path string to a hue in [0, 360).
 *  djb2 variant — stable across runs and well spread over short path sets. */
export function hashHue(folder: string): number {
  let h = 5381;
  for (let i = 0; i < folder.length; i++) {
    h = (h * 33) ^ folder.charCodeAt(i);
  }
  return Math.abs(h) % 360;
}

/** Effective hue for a tab, or null when it should not be tinted.
 *  A per-tab override (`colorHue`) wins; otherwise the folder is hashed. */
export function resolveHue(tab: Tab): number | null {
  if (tab.colorHue != null) return tab.colorHue;
  const folder = folderForTab(tab);
  return folder ? hashHue(folder) : null;
}
