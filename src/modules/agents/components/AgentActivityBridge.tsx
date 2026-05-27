import type { Tab } from "@/modules/tabs";
import {
  pollPanes,
  toCwdMap,
  toForegroundMap,
} from "@/modules/terminal/lib/foregroundPoll";
import {
  findLeafUuid,
  leafIds,
  type PaneNode,
} from "@/modules/terminal/lib/panes";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import type { ActivityState } from "../lib/activityState";
import { useActivityStore } from "../store/activityStore";

const POLL_MS = 1500;

type AgentStateEvent = { pane: string; state: ActivityState };

/** Collect every leaf uuid in a pane tree. */
function leafUuids(node: PaneNode): string[] {
  if (node.kind === "leaf") return node.uuid ? [node.uuid] : [];
  return node.children.flatMap(leafUuids);
}

/** Build a uuid -> leafId index across all terminal tabs. tmux reports panes by
 *  session name (the leaf uuid), but setLeafCwd keys on the numeric leaf id. */
function uuidToLeafId(tabs: Tab[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of tabs) {
    if (t.kind !== "terminal") continue;
    for (const id of leafIds(t.paneTree)) {
      const uuid = findLeafUuid(t.paneTree, id);
      if (uuid) map[uuid] = id;
    }
  }
  return map;
}

export function AgentActivityBridge({
  tabs,
  activeId,
  onLeafCwd,
}: {
  tabs: Tab[];
  activeId: number;
  /** Push a tmux-reported cwd into the tab model so the label follows `cd`
   *  (tmux swallows the shell's OSC 7, so polling is the only reliable source). */
  onLeafCwd: (leafId: number, cwd: string) => void;
}) {
  // Latest tabs/onLeafCwd for the long-lived poll interval below.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onLeafCwdRef = useRef(onLeafCwd);
  onLeafCwdRef.current = onLeafCwd;

  // Socket events — precise hook-reported state.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentStateEvent>("terax:agent-state", (e) => {
      const { pane, state } = e.payload;
      useActivityStore.getState().applyHook(pane, state, Date.now());
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Foreground + cwd poll interval (heuristic layer).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const panes = await pollPanes();
      if (cancelled) return;
      useActivityStore.getState().applyPoll(toForegroundMap(panes), Date.now());
      const byUuid = uuidToLeafId(tabsRef.current);
      for (const [uuid, cwd] of Object.entries(toCwdMap(panes))) {
        const leafId = byUuid[uuid];
        if (leafId !== undefined) onLeafCwdRef.current(leafId, cwd);
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Tab activation -> mark its leaves seen (done -> idle).
  const seenRef = useRef<number>(-1);
  useEffect(() => {
    if (seenRef.current === activeId) return;
    seenRef.current = activeId;
    const active = tabs.find((t) => t.id === activeId);
    if (active?.kind !== "terminal") return;
    const store = useActivityStore.getState();
    for (const uuid of leafUuids(active.paneTree)) store.markSeen(uuid);
  }, [activeId, tabs]);

  // Drop store entries for leaves that no longer exist (closed tabs/panes).
  useEffect(() => {
    const live = new Set<string>();
    for (const t of tabs) {
      if (t.kind === "terminal") for (const u of leafUuids(t.paneTree)) live.add(u);
    }
    const store = useActivityStore.getState();
    for (const uuid of Object.keys(store.leaves)) {
      if (!live.has(uuid)) store.dropLeaf(uuid);
    }
  }, [tabs]);

  return null;
}
