import type { Tab } from "@/modules/tabs";
import { pollForeground } from "@/modules/terminal/lib/foregroundPoll";
import type { PaneNode } from "@/modules/terminal/lib/panes";
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

export function AgentActivityBridge({
  tabs,
  activeId,
}: {
  tabs: Tab[];
  activeId: number;
}) {
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

  // Foreground poll interval (heuristic layer).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const fg = await pollForeground();
      if (!cancelled) useActivityStore.getState().applyPoll(fg, Date.now());
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
