import { describe, expect, it } from "vitest";
import {
  type ActivityState,
  type LeafActivity,
  computeHeuristicState,
  isShellCommand,
  isKnownAgent,
  rollUpStates,
  WORKING_QUIET_MS,
  BLOCKED_QUIET_MS,
} from "./activityState";

const base = (over: Partial<LeafActivity> = {}): LeafActivity => ({
  foreground: "zsh",
  lastOutputAt: 1000,
  seen: true,
  hadCommand: false,
  ...over,
});

describe("isShellCommand", () => {
  it("recognizes common shells", () => {
    for (const s of ["zsh", "bash", "fish", "sh", "pwsh", "nu"]) {
      expect(isShellCommand(s)).toBe(true);
    }
  });
  it("treats other commands as non-shell", () => {
    expect(isShellCommand("claude")).toBe(false);
    expect(isShellCommand("npm")).toBe(false);
    expect(isShellCommand("")).toBe(true); // empty == no command == shell-equivalent
  });
});

describe("isKnownAgent", () => {
  it("matches configured agents and ignores others", () => {
    expect(isKnownAgent("claude")).toBe(true);
    expect(isKnownAgent("codex")).toBe(true);
    expect(isKnownAgent("aider")).toBe(true);
    expect(isKnownAgent("npm")).toBe(false);
  });
});

describe("computeHeuristicState", () => {
  const now = 100_000;

  it("shell foreground + already seen => idle", () => {
    expect(computeHeuristicState(base({ foreground: "zsh", seen: true }), now)).toBe("idle");
  });

  it("shell foreground after a command, tab not seen => done", () => {
    expect(
      computeHeuristicState(base({ foreground: "zsh", hadCommand: true, seen: false }), now),
    ).toBe("done");
  });

  it("non-shell + recent output => working", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "npm", lastOutputAt: now - 500 }),
        now,
      ),
    ).toBe("working");
  });

  it("known agent + long quiet => blocked", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "claude", lastOutputAt: now - (BLOCKED_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("blocked");
  });

  it("non-agent command quiet a long time stays working (never blocked)", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "cargo", lastOutputAt: now - (BLOCKED_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("working");
  });

  it("non-shell quiet between working and blocked windows stays working", () => {
    expect(
      computeHeuristicState(
        base({ foreground: "claude", lastOutputAt: now - (WORKING_QUIET_MS + 1) }),
        now,
      ),
    ).toBe("working");
  });
});

describe("rollUpStates urgency: blocked > working > done > idle", () => {
  const cases: [ActivityState[], ActivityState][] = [
    [["idle", "idle"], "idle"],
    [["idle", "done"], "done"],
    [["done", "working"], "working"],
    [["working", "blocked"], "blocked"],
    [["blocked", "idle", "working"], "blocked"],
    [[], "idle"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} => ${expected}`, () => {
      expect(rollUpStates(input)).toBe(expected);
    });
  }
});
