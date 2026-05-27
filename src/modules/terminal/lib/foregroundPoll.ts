import { invoke } from "@tauri-apps/api/core";

export type PaneForeground = { uuid: string; command: string; path: string };

export function toForegroundMap(panes: PaneForeground[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of panes) map[p.uuid] = p.command;
  return map;
}

/** uuid -> current working directory, skipping panes with no reported path. */
export function toCwdMap(panes: PaneForeground[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of panes) if (p.path) map[p.uuid] = p.path;
  return map;
}

/** One batched tmux poll (foreground command + cwd per pane). Returns `[]`
 *  when tmux is unavailable so callers fall back gracefully. */
export async function pollPanes(): Promise<PaneForeground[]> {
  try {
    return await invoke<PaneForeground[]>("tmux_list_panes");
  } catch {
    return [];
  }
}
