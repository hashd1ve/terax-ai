import { describe, expect, it } from "vitest";
import { toCwdMap, toForegroundMap, type PaneForeground } from "./foregroundPoll";

const panes: PaneForeground[] = [
  { uuid: "a", command: "zsh", path: "/Users/me" },
  { uuid: "b", command: "node", path: "/Users/me/proj" },
  { uuid: "c", command: "zsh", path: "" },
];

describe("toForegroundMap", () => {
  it("maps uuid to command", () => {
    expect(toForegroundMap(panes)).toEqual({ a: "zsh", b: "node", c: "zsh" });
  });

  it("handles an empty list", () => {
    expect(toForegroundMap([])).toEqual({});
  });
});

describe("toCwdMap", () => {
  it("maps uuid to path, skipping panes with no path", () => {
    expect(toCwdMap(panes)).toEqual({ a: "/Users/me", b: "/Users/me/proj" });
  });

  it("handles an empty list", () => {
    expect(toCwdMap([])).toEqual({});
  });
});
