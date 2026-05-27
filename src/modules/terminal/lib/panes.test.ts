import { describe, expect, it } from "vitest";
import {
  findLeafUuid,
  newLeafUuid,
  splitLeaf,
  type PaneNode,
} from "./panes";

describe("leaf uuid", () => {
  it("newLeafUuid returns a non-empty unique string", () => {
    const a = newLeafUuid();
    const b = newLeafUuid();
    expect(a).toMatch(/\S/);
    expect(a).not.toBe(b);
  });

  it("findLeafUuid returns the uuid of a matching leaf", () => {
    const tree: PaneNode = { kind: "leaf", id: 2, uuid: "u-2" };
    expect(findLeafUuid(tree, 2)).toBe("u-2");
    expect(findLeafUuid(tree, 99)).toBeUndefined();
  });

  it("splitLeaf carries a uuid onto the new leaf", () => {
    const tree: PaneNode = { kind: "leaf", id: 2, uuid: "u-2" };
    const next = splitLeaf(tree, 2, 3, 4, "row", undefined, "u-4");
    const ids: string[] = [];
    const walk = (n: PaneNode) =>
      n.kind === "leaf" ? ids.push(n.uuid) : n.children.forEach(walk);
    walk(next);
    expect(ids).toContain("u-2");
    expect(ids).toContain("u-4");
  });
});
