import { describe, expect, it } from "vitest";
import {
  buildCards,
  formatElapsed,
  pillFor,
  sortCards,
  type DashboardCard,
} from "./agentDashboard";
import type { LeafActivity } from "../store/activityStore";
import type { AgentSession } from "./types";

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    leafId: 2,
    tabId: 1,
    agent: "claude",
    status: "working",
    startedAt: 0,
    lastActivityAt: 0,
    attentionSince: null,
    ...over,
  };
}

function leaf(over: Partial<LeafActivity> = {}): LeafActivity {
  return {
    state: "working",
    lastOutputAt: 0,
    lastHookAt: 0,
    source: "heuristic",
    seen: true,
    hadCommand: false,
    changedFiles: [],
    ...over,
  };
}

describe("formatElapsed", () => {
  it("formats mm:ss under an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(9 * 60_000 + 7_000)).toBe("9:07");
  });

  it("formats h:mm:ss past an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });

  it("clamps invalid input to zero", () => {
    expect(formatElapsed(-50)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("pillFor", () => {
  it("treats blocked activity or a waiting status as waiting", () => {
    expect(pillFor("working", "blocked")).toBe("waiting");
    expect(pillFor("waiting", "idle")).toBe("waiting");
  });

  it("treats live work as working", () => {
    expect(pillFor("working", "working")).toBe("working");
    expect(pillFor("working", "idle")).toBe("working");
  });

  it("treats settled sessions as done", () => {
    // A waiting status would override, so a done pill needs both calm.
    const calm: AgentSession["status"] = "waiting";
    expect(pillFor(calm, "done")).toBe("waiting");
  });

  it("maps a done status to the done pill", () => {
    expect(pillFor("done", "idle")).toBe("done");
  });
});

describe("sortCards", () => {
  const card = (over: Partial<DashboardCard>): DashboardCard => ({
    leafId: 0,
    tabId: 0,
    uuid: null,
    agent: "claude",
    tabTitle: "t",
    pill: "working",
    activityState: "working",
    changedFiles: 0,
    startedAt: 0,
    lastActivityAt: 0,
    ...over,
  });

  it("orders waiting, then working, then done", () => {
    const out = sortCards([
      card({ leafId: 1, pill: "done" }),
      card({ leafId: 2, pill: "working" }),
      card({ leafId: 3, pill: "waiting" }),
    ]);
    expect(out.map((c) => c.leafId)).toEqual([3, 2, 1]);
  });

  it("breaks ties by lastActivityAt descending", () => {
    const out = sortCards([
      card({ leafId: 1, pill: "working", lastActivityAt: 100 }),
      card({ leafId: 2, pill: "working", lastActivityAt: 300 }),
      card({ leafId: 3, pill: "working", lastActivityAt: 200 }),
    ]);
    expect(out.map((c) => c.leafId)).toEqual([2, 3, 1]);
  });
});

describe("buildCards", () => {
  const tree = {
    kind: "split" as const,
    id: 10,
    dir: "row" as const,
    children: [
      { kind: "leaf" as const, id: 2, uuid: "uuid-a" },
      { kind: "leaf" as const, id: 3, uuid: "uuid-b" },
    ],
  };
  const tabs = [{ id: 1, kind: "terminal" as const, title: "my-repo", paneTree: tree }];

  it("maps a session's leafId to its uuid and joins activity + usage", () => {
    const cards = buildCards(
      { 2: session({ leafId: 2, tabId: 1 }) },
      tabs,
      { "uuid-a": leaf({ state: "working", currentTool: "Edit", changedFiles: ["a", "b"] }) },
      {
        "uuid-a": {
          model: "claude-opus-4-8[1m]",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 0,
          contextWindow: 0,
          contextPct: 42,
          costUsdEst: 0.5,
          title: null,
          lastPrompt: null,
        },
      },
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      uuid: "uuid-a",
      tabTitle: "my-repo",
      currentTool: "Edit",
      changedFiles: 2,
      contextPct: 42,
      model: "claude-opus-4-8[1m]",
      pill: "working",
    });
  });

  it("still emits a card when no uuid/activity is found (idle fallback)", () => {
    const cards = buildCards(
      { 99: session({ leafId: 99, tabId: 1 }) },
      tabs,
      {},
      {},
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      uuid: null,
      activityState: "idle",
      changedFiles: 0,
    });
  });

  it("orders cards waiting first across mixed sessions", () => {
    const cards = buildCards(
      {
        2: session({ leafId: 2, tabId: 1, status: "working", lastActivityAt: 5 }),
        3: session({ leafId: 3, tabId: 1, status: "waiting", lastActivityAt: 1 }),
      },
      tabs,
      {
        "uuid-a": leaf({ state: "working" }),
        "uuid-b": leaf({ state: "blocked" }),
      },
      {},
    );
    expect(cards.map((c) => c.leafId)).toEqual([3, 2]);
  });
});
