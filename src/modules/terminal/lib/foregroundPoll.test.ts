import { describe, expect, it } from "vitest";
import { toForegroundMap, type PaneForeground } from "./foregroundPoll";

describe("toForegroundMap", () => {
  it("maps uuid to command", () => {
    const panes: PaneForeground[] = [
      { uuid: "a", command: "zsh" },
      { uuid: "b", command: "claude" },
    ];
    expect(toForegroundMap(panes)).toEqual({ a: "zsh", b: "claude" });
  });

  it("handles an empty list", () => {
    expect(toForegroundMap([])).toEqual({});
  });
});
