import type { Tab } from "@/modules/tabs";
import { findLeafUuid } from "@/modules/terminal/lib/panes";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo } from "react";
import { useActivityStore } from "../store/activityStore";
import { type TodoItem, useTodosStore } from "../store/todosStore";

/** Slow enough that an idle-but-mounted agent costs nothing noticeable, fast
 *  enough that the plan tracks the CLI within a step. */
const POLL_MS = 2000;

/** Read the on-disk plan once for a session, tolerating a missing file/host. */
async function refresh(sessionId: string): Promise<void> {
  try {
    const items = await invoke<TodoItem[]>("agent_read_todos", { sessionId });
    useTodosStore.getState().setTodos(sessionId, items);
  } catch {
    // No todos dir, an unparseable file, or a rejected id: leave the last
    // known plan in place rather than flashing it empty on a transient miss.
  }
}

/**
 * Polls the active terminal leaf's Claude plan file while (and only while) that
 * leaf has a live agent session. The session id already rides on the activity
 * store via the terax:agent-meta hook channel, so this adds no new plumbing and
 * is fully dormant when no agent is running.
 */
export function AgentTodosBridge({
  tabs,
  activeId,
}: {
  tabs: Tab[];
  activeId: number;
}) {
  const activeLeafUuid = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || t.kind !== "terminal") return undefined;
    return findLeafUuid(t.paneTree, t.activeLeafId);
  }, [tabs, activeId]);

  // Subscribe narrowly: only the active leaf's session id and working flag drive
  // polling, so unrelated activity (other panes, cwd polls) never re-renders us.
  const sessionId = useActivityStore((s) =>
    activeLeafUuid ? s.leaves[activeLeafUuid]?.sessionId : undefined,
  );
  const working = useActivityStore((s) =>
    activeLeafUuid ? s.leaves[activeLeafUuid]?.state === "working" : false,
  );

  useEffect(() => {
    if (!sessionId) return;
    // Read once immediately so switching to a settled (non-working) agent still
    // shows its final plan; then keep polling only while it is actively working.
    void refresh(sessionId);
    if (!working) return;
    const handle = setInterval(() => void refresh(sessionId), POLL_MS);
    return () => clearInterval(handle);
  }, [sessionId, working]);

  return null;
}
