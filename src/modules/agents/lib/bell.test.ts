import { describe, expect, it } from "vitest";
import { bellBadgeCount } from "./bell";
import type { AgentNotification, AgentSession } from "./types";

function session(leafId: number, status: AgentSession["status"]): AgentSession {
  return {
    leafId,
    tabId: leafId,
    agent: "claude",
    status,
    startedAt: 0,
    lastActivityAt: 0,
    attentionSince: null,
  };
}

function note(kind: AgentNotification["kind"], read: boolean): AgentNotification {
  return { id: `n${kind}${read}`, source: "terminal", leafId: 1, tabId: 1, agent: "claude", kind, at: 0, read };
}

describe("bellBadgeCount", () => {
  it("counts waiting sessions plus unread errors, ignoring finished", () => {
    const sessions = [session(1, "waiting"), session(2, "working"), session(3, "waiting")];
    const notifications = [
      note("error", false),
      note("error", true),
      note("finished", false),
    ];
    expect(bellBadgeCount(sessions, notifications)).toBe(3); // 2 waiting + 1 unread error
  });

  it("is zero when nothing needs attention", () => {
    expect(bellBadgeCount([session(1, "working")], [note("finished", false)])).toBe(0);
  });

  it("does not count done sessions as needing attention", () => {
    expect(bellBadgeCount([session(1, "done"), session(2, "waiting")], [])).toBe(1);
  });
});
