import { LazyStore } from "@tauri-apps/plugin-store";
import type { Tab } from "@/modules/tabs";
import {
  findLeafUuid,
  leafIds,
  type PaneNode,
} from "@/modules/terminal/lib/panes";

const SESSION_PREFIX = "terax_";

// Only these tab kinds restore by descriptor. ai-diff/git-diff/git-commit-file
// are transient (tied to a live approval or working-tree state) and are dropped.
const RESTORABLE_KINDS = new Set([
  "terminal",
  "editor",
  "preview",
  "markdown",
  "git-history",
]);

export type PersistedWorkspace = {
  version: 1;
  activeId: number;
  tabs: Tab[];
};

const STORE_PATH = "terax-workspace.json";
const KEY = "workspace";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Pure: produce the persistable snapshot. Excludes private terminals and
 *  non-restorable tab kinds. Editor `preview`/`dirty` flags are normalized. */
export function serializeWorkspace(
  tabs: Tab[],
  activeId: number,
): PersistedWorkspace {
  const kept = tabs.filter((t) => {
    if (!RESTORABLE_KINDS.has(t.kind)) return false;
    if (t.kind === "terminal" && t.private) return false;
    return true;
  });
  const nextActive = kept.some((t) => t.id === activeId)
    ? activeId
    : (kept[0]?.id ?? activeId);
  return { version: 1, activeId: nextActive, tabs: kept };
}

/** Pure inverse — currently a structural pass-through plus active resolution.
 *  Kept as a function so future schema migration has a single seam. */
export function deserializeWorkspace(snap: PersistedWorkspace): {
  tabs: Tab[];
  activeId: number;
} {
  const tabs = snap.tabs ?? [];
  const activeId = tabs.some((t) => t.id === snap.activeId)
    ? snap.activeId
    : (tabs[0]?.id ?? snap.activeId);
  return { tabs, activeId };
}

/** Pure: every tmux session name referenced by the snapshot's terminal leaves. */
export function referencedSessionNames(snap: PersistedWorkspace): string[] {
  const names: string[] = [];
  for (const t of snap.tabs) {
    if (t.kind !== "terminal") continue;
    for (const id of leafIds(t.paneTree)) {
      const uuid = findLeafUuid(t.paneTree as PaneNode, id);
      if (uuid) names.push(`${SESSION_PREFIX}${uuid}`);
    }
  }
  return names;
}

// Set of leaf uuids that existed in the snapshot loaded at launch. Used to
// trigger one-time scrollback preload only for restored panes (not freshly
// created tabs). Populated once on boot from the persisted snapshot.
const restoredLeafUuids = new Set<string>();

/** Record the leaf uuids from the snapshot loaded at launch. */
export function markRestoredLeaves(snap: PersistedWorkspace | null): void {
  restoredLeafUuids.clear();
  if (!snap) return;
  for (const name of referencedSessionNames(snap)) {
    restoredLeafUuids.add(name.slice(SESSION_PREFIX.length));
  }
}

/** True if this leaf uuid came from the snapshot restored at launch. */
export function isRestoredLeaf(uuid: string | undefined): boolean {
  return uuid !== undefined && restoredLeafUuids.has(uuid);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persist (200ms). Mirrors the autoSave cadence used elsewhere. */
export function scheduleWorkspaceSave(tabs: Tab[], activeId: number): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistWorkspace(tabs, activeId);
  }, 200);
}

/** Immediate, awaited persist — used by the window-close flush. */
export async function persistWorkspace(
  tabs: Tab[],
  activeId: number,
): Promise<void> {
  const snap = serializeWorkspace(tabs, activeId);
  await store.set(KEY, snap);
  await store.save();
}

/** Returns null on first run (no file). */
export async function loadWorkspace(): Promise<PersistedWorkspace | null> {
  try {
    const snap = await store.get<PersistedWorkspace>(KEY);
    if (!snap || snap.version !== 1 || !Array.isArray(snap.tabs)) return null;
    return snap;
  } catch {
    return null;
  }
}
