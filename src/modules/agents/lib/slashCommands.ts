import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { DirEntry } from "@/modules/system/native";
import type { SlashCommand } from "@/modules/agents/components/QuickPromptPalette";

/**
 * Derive a slash-command name from a directory entry, or null when the entry
 * is not a command/skill we can name. A `*.md` file yields its basename
 * without the extension (Claude Code command files); a directory yields its
 * name (a skill folder holding SKILL.md). Anything else is skipped.
 */
export function deriveCommandName(entry: DirEntry): string | null {
  if (entry.kind === "dir") {
    const name = entry.name.trim();
    return name && !name.startsWith(".") ? name : null;
  }
  if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
    const base = entry.name.slice(0, -3).trim();
    return base && !base.startsWith(".") ? base : null;
  }
  return null;
}

async function namesIn(path: string): Promise<string[]> {
  try {
    const entries = await invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: true,
      workspace: currentWorkspaceEnv(),
    });
    return entries
      .map(deriveCommandName)
      .filter((n): n is string => n !== null);
  } catch {
    return [];
  }
}

/**
 * Best-effort discovery of the user's Claude Code commands and skills, from
 * both `~/.claude` and the project's `<cwd>/.claude`. Errors (missing dirs,
 * unauthorized paths) are swallowed so discovery never blocks the palette.
 * Names are de-duplicated and sorted.
 */
export async function discoverSlashCommands(
  homeDir: string | null,
  projectDir: string | null,
): Promise<SlashCommand[]> {
  const roots = [homeDir, projectDir].filter(
    (d): d is string => !!d,
  );
  const dirs = roots.flatMap((root) => {
    const base = `${root.replace(/[\\/]+$/, "")}/.claude`;
    return [`${base}/commands`, `${base}/skills`];
  });
  const lists = await Promise.all(dirs.map(namesIn));
  const seen = new Set<string>();
  for (const name of lists.flat()) seen.add(name);
  return [...seen]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }));
}
