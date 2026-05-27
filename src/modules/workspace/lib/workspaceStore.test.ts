import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import {
  referencedSessionNames,
  serializeWorkspace,
  deserializeWorkspace,
} from "./workspaceStore";

const terminalTab = (over: Partial<Extract<Tab, { kind: "terminal" }>> = {}) =>
  ({
    id: 1,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, uuid: "u-2", cwd: "/a" },
    activeLeafId: 2,
    ...over,
  }) as Tab;

const editorTab = (): Tab =>
  ({
    id: 3,
    kind: "editor",
    title: "f.ts",
    path: "/a/f.ts",
    dirty: false,
    preview: false,
  }) as Tab;

describe("workspace serialization", () => {
  it("round-trips terminal + editor tabs and active id", () => {
    const tabs: Tab[] = [terminalTab(), editorTab()];
    const snap = serializeWorkspace(tabs, 1);
    const { tabs: out, activeId } = deserializeWorkspace(snap);
    expect(activeId).toBe(1);
    expect(out).toHaveLength(2);
    const t = out[0];
    expect(t.kind).toBe("terminal");
    if (t.kind === "terminal") {
      expect(t.paneTree).toEqual({
        kind: "leaf",
        id: 2,
        uuid: "u-2",
        cwd: "/a",
      });
    }
  });

  it("excludes private terminals from the snapshot", () => {
    const tabs: Tab[] = [terminalTab(), terminalTab({ id: 9, private: true })];
    const snap = serializeWorkspace(tabs, 1);
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0].id).toBe(1);
  });

  it("drops volatile non-restorable tabs (ai-diff, git-diff, git-commit-file)", () => {
    const tabs = [
      terminalTab(),
      {
        id: 4,
        kind: "ai-diff",
        title: "x",
        path: "/a",
        originalContent: "",
        proposedContent: "",
        approvalId: "ap",
        status: "pending",
        isNewFile: false,
      },
    ] as Tab[];
    const snap = serializeWorkspace(tabs, 1);
    expect(snap.tabs.map((t) => t.kind)).toEqual(["terminal"]);
  });

  it("referencedSessionNames returns terax_<uuid> for every persisted leaf", () => {
    const tabs: Tab[] = [
      terminalTab({
        paneTree: {
          kind: "split",
          id: 5,
          dir: "row",
          children: [
            { kind: "leaf", id: 2, uuid: "u-2", cwd: "/a" },
            { kind: "leaf", id: 6, uuid: "u-6", cwd: "/b" },
          ],
        },
      }),
    ];
    const snap = serializeWorkspace(tabs, 1);
    expect(referencedSessionNames(snap).sort()).toEqual([
      "terax_u-2",
      "terax_u-6",
    ]);
  });

  it("active id falls back to the first surviving tab when the active was dropped", () => {
    const tabs: Tab[] = [
      terminalTab({ id: 9, private: true }),
      terminalTab({ id: 1 }),
    ];
    const snap = serializeWorkspace(tabs, 9); // active was the private tab
    const { activeId } = deserializeWorkspace(snap);
    expect(activeId).toBe(1);
  });
});
