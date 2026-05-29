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

  it("setMeta merges only present fields and never clobbers known ones", () => {
    const s = useActivityStore.getState();
    s.setMeta("u1", { tool: "Edit", session: "sid", cwd: "/proj", transcript: "/t.jsonl" });
    let leaf = useActivityStore.getState().leaves["u1"];
    expect(leaf.currentTool).toBe("Edit");
    expect(leaf.sessionId).toBe("sid");
    expect(leaf.transcriptPath).toBe("/t.jsonl");
    expect(leaf.agentCwd).toBe("/proj");

    // A later event carrying only session/cwd must not wipe the known tool.
    s.setMeta("u1", { tool: null, session: "sid", cwd: "/proj" });
    leaf = useActivityStore.getState().leaves["u1"];
    expect(leaf.currentTool).toBe("Edit");
  });

  it("setMeta preserves an existing activity state", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "working", 1000);
    s.setMeta("u1", { tool: "Bash" });
    const leaf = useActivityStore.getState().leaves["u1"];
    expect(leaf.state).toBe("working");
    expect(leaf.currentTool).toBe("Bash");
  });

  it("setMeta with a file appends, dedupes by exact path, and caps at 50", () => {
    const s = useActivityStore.getState();
    s.setMeta("u1", { file: "/a.ts" });
    s.setMeta("u1", { file: "/a.ts" }); // duplicate, must not double-count
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual(["/a.ts"]);

    for (let i = 0; i < 60; i++) s.setMeta("u1", { file: `/f${i}.ts` });
    const files = useActivityStore.getState().leaves["u1"].changedFiles;
    expect(files.length).toBe(50);
    // Oldest dropped, most recent kept last.
    expect(files[files.length - 1]).toBe("/f59.ts");
    expect(files).not.toContain("/a.ts");
  });

  it("setMeta accumulates distinct files in order", () => {
    const s = useActivityStore.getState();
    s.setMeta("u1", { file: "/a.ts" });
    s.setMeta("u1", { file: "/b.ts" });
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual([
      "/a.ts",
      "/b.ts",
    ]);
  });

  it("applyHook done -> working clears changedFiles", () => {
    const s = useActivityStore.getState();
    s.setMeta("u1", { file: "/a.ts" });
    s.applyHook("u1", "done", 1000);
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual(["/a.ts"]);
    s.applyHook("u1", "working", 2000);
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual([]);
  });

  it("applyHook blocked -> working keeps changedFiles (same turn)", () => {
    const s = useActivityStore.getState();
    s.applyHook("u1", "working", 1000);
    s.setMeta("u1", { file: "/a.ts" });
    s.applyHook("u1", "blocked", 2000); // mid-turn: agent asked for input
    s.applyHook("u1", "working", 3000); // user replied, same turn resumes
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual(["/a.ts"]);
  });

  it("setMeta without a file leaves changedFiles untouched", () => {
    const s = useActivityStore.getState();
    s.setMeta("u1", { file: "/a.ts" });
    s.setMeta("u1", { tool: "Bash", cwd: "/proj" });
    expect(useActivityStore.getState().leaves["u1"].changedFiles).toEqual(["/a.ts"]);
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
