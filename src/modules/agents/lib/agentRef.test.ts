import { describe, expect, it } from "vitest";
import { buildAgentRef, pickAgentLeafId } from "./agentRef";
import { useAgentStore } from "@/modules/agents/store/agentStore";

describe("buildAgentRef", () => {
  it("formats a single-line range with #L<start>", () => {
    expect(buildAgentRef("/repo/src/foo.ts", "/repo", { startLine: 5, endLine: 5 })).toBe(
      " @src/foo.ts#L5 ",
    );
  });

  it("formats a multi-line range with #L<start>-<end>", () => {
    expect(buildAgentRef("/repo/src/foo.ts", "/repo", { startLine: 5, endLine: 9 })).toBe(
      " @src/foo.ts#L5-9 ",
    );
  });

  it("omits the suffix when no range is given", () => {
    expect(buildAgentRef("/repo/src/foo.ts", "/repo")).toBe(" @src/foo.ts ");
    expect(buildAgentRef("/repo/src/foo.ts", "/repo", null)).toBe(" @src/foo.ts ");
  });

  it("relativizes the path against agentCwd", () => {
    expect(buildAgentRef("/home/u/proj/a/b.ts", "/home/u/proj")).toBe(" @a/b.ts ");
  });

  it("falls back to the absolute path when no cwd is given", () => {
    expect(buildAgentRef("/repo/src/foo.ts")).toBe(" @/repo/src/foo.ts ");
    expect(buildAgentRef("/repo/src/foo.ts", null)).toBe(" @/repo/src/foo.ts ");
    expect(buildAgentRef("/repo/src/foo.ts", "")).toBe(" @/repo/src/foo.ts ");
  });

  it("falls back to the absolute path when cwd is not a prefix", () => {
    expect(buildAgentRef("/repo/src/foo.ts", "/other/dir")).toBe(" @/repo/src/foo.ts ");
  });

  it("has exactly one leading and one trailing space", () => {
    const out = buildAgentRef("/repo/src/foo.ts", "/repo", { startLine: 1, endLine: 2 });
    expect(out.startsWith(" ")).toBe(true);
    expect(out.endsWith(" ")).toBe(true);
    expect(out.startsWith("  ")).toBe(false);
    expect(out.endsWith("  ")).toBe(false);
  });

  it("never contains a newline or carriage return", () => {
    const cases = [
      buildAgentRef("/repo/src/foo.ts", "/repo"),
      buildAgentRef("/repo/src/foo.ts", "/repo", { startLine: 5, endLine: 5 }),
      buildAgentRef("/repo/src/foo.ts", "/repo", { startLine: 5, endLine: 9 }),
      buildAgentRef("/repo/src/foo.ts"),
    ];
    for (const out of cases) {
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\r");
    }
  });
});

describe("pickAgentLeafId", () => {
  it("pickAgentLeafId prefers a ready (done) session over a working one", () => {
    useAgentStore.setState({ sessions: {}, notifications: [] });
    const s = useAgentStore.getState();
    s.start(1, 10, "claude"); // leaf 1: will be working
    s.start(2, 11, "claude"); // leaf 2: will be done
    s.setStatus(1, "working");
    s.setStatus(2, "done");
    // Make the WORKING one the most recently active, to prove readiness wins over recency.
    useAgentStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        1: { ...st.sessions[1], lastActivityAt: 1000 },
        2: { ...st.sessions[2], lastActivityAt: 1 },
      },
    }));
    expect(pickAgentLeafId(null)).toBe(2);
  });
});
