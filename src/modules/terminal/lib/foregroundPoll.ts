import { invoke } from "@tauri-apps/api/core";

export type PaneForeground = { uuid: string; command: string };

export function toForegroundMap(panes: PaneForeground[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of panes) map[p.uuid] = p.command;
  return map;
}

/** One batched tmux foreground poll. Returns `{}` when tmux is unavailable. */
export async function pollForeground(): Promise<Record<string, string>> {
  try {
    const panes = await invoke<PaneForeground[]>("tmux_list_panes");
    return toForegroundMap(panes);
  } catch {
    return {};
  }
}
