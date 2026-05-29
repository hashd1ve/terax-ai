import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "./agentStore";

function reset() {
  useAgentStore.setState({ sessions: {}, notifications: [] });
}

describe("agentStore", () => {
  beforeEach(reset);

  it("upsertFinished keeps one row per leaf and refreshes it to the top", () => {
    const s = useAgentStore.getState();
    s.upsertFinished({ leafId: 1, tabId: 10, agent: "claude", title: "Task A" });
    s.upsertFinished({ leafId: 2, tabId: 11, agent: "claude", title: "Task B" });
    s.upsertFinished({ leafId: 1, tabId: 10, agent: "claude", title: "Task A v2" });

    const notes = useAgentStore.getState().notifications;
    const finishedForLeaf1 = notes.filter(
      (n) => n.kind === "finished" && n.leafId === 1,
    );
    expect(finishedForLeaf1).toHaveLength(1);
    expect(finishedForLeaf1[0].title).toBe("Task A v2");
    expect(notes[0].leafId).toBe(1);
  });

  it("setContext merges fields onto the session without clobbering", () => {
    const s = useAgentStore.getState();
    s.start(1, 10, "claude");
    s.setContext(1, { title: "My title" });
    s.setContext(1, { lastPrompt: "do the thing" });

    const session = useAgentStore.getState().sessions[1];
    expect(session.title).toBe("My title");
    expect(session.lastPrompt).toBe("do the thing");
  });

  it("setContext on a missing session is a no-op", () => {
    useAgentStore.getState().setContext(99, { title: "x" });
    expect(useAgentStore.getState().sessions[99]).toBeUndefined();
  });

  it("setStatus done leaves attentionSince null", () => {
    const s = useAgentStore.getState();
    s.start(1, 10, "claude");
    s.setStatus(1, "done");
    const session = useAgentStore.getState().sessions[1];
    expect(session.status).toBe("done");
    expect(session.attentionSince).toBeNull();
  });

  it("pushNotification carries the title snapshot", () => {
    useAgentStore.getState().pushNotification({
      source: "terminal",
      leafId: 3,
      tabId: 12,
      agent: "claude",
      kind: "error",
      title: "Broken build",
    });
    expect(useAgentStore.getState().notifications[0].title).toBe("Broken build");
  });
});
