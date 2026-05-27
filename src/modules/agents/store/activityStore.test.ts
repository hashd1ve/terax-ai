import { beforeEach, describe, expect, it } from "vitest";
import { useActivityStore, HOOK_STALE_MS } from "./activityStore";

const reset = () => useActivityStore.setState({ leaves: {} });

describe("activityStore", () => {
  beforeEach(reset);

  it("records output activity and infers heuristic state on poll", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 1000);
    // foreground claude, last output 1000, polled at 1500 => working
    s.applyPoll({ u1: "claude" }, 1500);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("working");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("heuristic");
  });

  it("hook state overrides heuristic and wins until stale", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 0);
    s.applyHook("u1", "blocked", 1000);
    // a poll that would say working must NOT override a fresh hook
    s.applyPoll({ u1: "claude" }, 1000 + 500);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("blocked");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("hook");
  });

  it("heuristic takes over once the hook state is stale", () => {
    const s = useActivityStore.getState();
    s.recordOutput("u1", 0);
    s.applyHook("u1", "blocked", 1000);
    s.applyPoll({ u1: "zsh" }, 1000 + HOOK_STALE_MS + 1); // shell + seen=false default? mark seen below
    s.markSeen("u1"); // viewed -> idle
    s.applyPoll({ u1: "zsh" }, 1000 + HOOK_STALE_MS + 2);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("idle");
    expect(useActivityStore.getState().leaves["u1"].source).toBe("heuristic");
  });

  it("markSeen clears a done state to idle and sets seen", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "done", 1000);
    s.markSeen("u1");
    // done is a hook state; markSeen flips seen and downgrades done->idle
    expect(useActivityStore.getState().leaves["u1"].state).toBe("idle");
  });

  it("rollUpFor computes a tab's most urgent leaf state", () => {
    const s = useActivityStore.getState();
    s.applyHook("a", "idle", 1000);
    s.applyHook("b", "blocked", 1000);
    expect(useActivityStore.getState().rollUpFor(["a", "b"])).toBe("blocked");
    expect(useActivityStore.getState().rollUpFor(["a"])).toBe("idle");
    expect(useActivityStore.getState().rollUpFor(["missing"])).toBe("idle");
  });

  it("dropLeaf removes a leaf entry", () => {
    const s = useActivityStore.getState();
    s.applyHook("a", "working", 1000);
    s.dropLeaf("a");
    expect(useActivityStore.getState().leaves["a"]).toBeUndefined();
  });
});

describe("no-tmux fallback", () => {
  beforeEach(() => useActivityStore.setState({ leaves: {} }));

  it("empty poll does not change existing leaf states", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "working", 1000);
    s.applyPoll({}, 2000); // tmux unavailable
    expect(useActivityStore.getState().leaves["u1"].state).toBe("working");
  });

  it("hook-only flow works with no foreground polls at all", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "blocked", 1000);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("blocked");
    s.applyHook("u1", "done", 2000);
    expect(useActivityStore.getState().leaves["u1"].state).toBe("done");
  });
});
