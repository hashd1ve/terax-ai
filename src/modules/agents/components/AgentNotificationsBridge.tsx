import type { Tab } from "@/modules/tabs";
import { findLeafUuid } from "@/modules/terminal/lib/panes";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { alertAgentAttention } from "../lib/route";
import type { AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useActivityStore } from "../store/activityStore";
import { useAgentStore } from "../store/agentStore";
import type { UsageInfo } from "../store/usageStore";

type Activate = (tabId: number, leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): { tabId: number; title: string } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, title: t.title };
    }
  }
  return null;
}

/** The transcript path lives in the activity store keyed by the leaf uuid; map
 *  leafId -> uuid the same way the dashboard does. */
function transcriptPathForLeaf(tabs: Tab[], leafId: number): string | null {
  for (const t of tabs) {
    if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) continue;
    const uuid = findLeafUuid(t.paneTree, leafId);
    if (!uuid) return null;
    return useActivityStore.getState().leaves[uuid]?.transcriptPath ?? null;
  }
  return null;
}

/** Resolve and cache the conversation title (and last prompt) on the session.
 *  Skips the read when a title is already cached unless forceFresh is set
 *  (needs-input wants the live last prompt every time). One bounded fs read. */
async function ensureContext(
  leafId: number,
  ctx: Ctx,
  forceFresh: boolean,
): Promise<void> {
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  if (!session) return;
  if (!forceFresh && session.title) return;
  const transcriptPath = transcriptPathForLeaf(ctx.tabs, leafId);
  if (!transcriptPath) return;
  try {
    const info = await invoke<UsageInfo | null>("agent_read_usage", {
      transcriptPath,
    });
    if (info) {
      store.setContext(leafId, { title: info.title, lastPrompt: info.lastPrompt });
    }
  } catch {
    // Rejected path / unreadable / drift: keep whatever context we had.
  }
}

async function onAttention(leafId: number, ctx: Ctx): Promise<void> {
  await ensureContext(leafId, ctx, true);
  const session = useAgentStore.getState().sessions[leafId];
  if (!session) return;
  const info = tabInfo(ctx.tabs, leafId);
  alertAgentAttention({
    agent: session.agent,
    title: `${session.agent} needs your input`,
    body: session.title ?? info?.title,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    allowToast: true,
    onActivate: () => ctx.onActivate(session.tabId, session.leafId),
  });
}

async function onFinished(leafId: number, ctx: Ctx): Promise<void> {
  if (!usePreferencesStore.getState().agentNotifications) return;
  await ensureContext(leafId, ctx, false);
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  const info = tabInfo(ctx.tabs, leafId);
  store.upsertFinished({
    leafId,
    tabId: session?.tabId ?? info?.tabId ?? 0,
    agent: session?.agent ?? "claude",
    title: session?.title,
  });
}

async function onError(leafId: number, ctx: Ctx): Promise<void> {
  await ensureContext(leafId, ctx, false);
  const store = useAgentStore.getState();
  const session = store.sessions[leafId];
  const info = tabInfo(ctx.tabs, leafId);
  store.pushNotification({
    source: "terminal",
    agent: session?.agent ?? "claude",
    kind: "error",
    tabId: info?.tabId ?? session?.tabId ?? 0,
    leafId,
    title: session?.title,
  });
}

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      store.start(leafId, info.tabId, sig.agent ?? "agent");
      return;
    }
    case "working":
      store.setStatus(leafId, "working");
      return;
    case "attention":
      store.setStatus(leafId, "waiting");
      void onAttention(leafId, ctx);
      return;
    case "finished":
      store.setStatus(leafId, "done");
      void onFinished(leafId, ctx);
      return;
    case "error":
      void onError(leafId, ctx);
      return;
    case "exited":
      store.finish(leafId);
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate });
  ctxRef.current = { tabs, activeId, focused, onActivate };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("terax:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
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

  return null;
}
