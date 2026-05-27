import { describe, expect, it } from "vitest";
import { folderForTab, hashHue, resolveHue } from "./tabColor";
import type {
  EditorTab,
  GitDiffTab,
  MarkdownTab,
  PreviewTab,
  TerminalTab,
} from "./useTabs";

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, uuid: "u-test" },
    activeLeafId: 2,
    ...over,
  };
}

describe("folderForTab", () => {
  it("uses cwd for terminal tabs", () => {
    expect(folderForTab(terminalTab({ cwd: "/Users/me/proj" }))).toBe(
      "/Users/me/proj",
    );
  });

  it("returns null for a terminal without cwd", () => {
    expect(folderForTab(terminalTab())).toBeNull();
  });

  it("uses the parent directory for editor tabs", () => {
    const tab: EditorTab = {
      id: 1,
      kind: "editor",
      title: "a.ts",
      path: "/Users/me/proj/src/a.ts",
      dirty: false,
      preview: false,
    };
    expect(folderForTab(tab)).toBe("Users/me/proj/src");
  });

  it("uses the parent directory for markdown tabs", () => {
    const tab: MarkdownTab = {
      id: 1,
      kind: "markdown",
      title: "README.md",
      path: "/Users/me/proj/README.md",
    };
    expect(folderForTab(tab)).toBe("Users/me/proj");
  });

  it("uses repoRoot for git tabs", () => {
    const tab: GitDiffTab = {
      id: 1,
      kind: "git-diff",
      title: "a.ts (+)",
      path: "src/a.ts",
      repoRoot: "/Users/me/proj",
      mode: "+",
      originalPath: null,
    };
    expect(folderForTab(tab)).toBe("/Users/me/proj");
  });

  it("returns null for preview tabs", () => {
    const tab: PreviewTab = {
      id: 1,
      kind: "preview",
      title: "example.com",
      url: "https://example.com",
    };
    expect(folderForTab(tab)).toBeNull();
  });
});

describe("hashHue", () => {
  it("is deterministic", () => {
    expect(hashHue("/Users/me/proj")).toBe(hashHue("/Users/me/proj"));
  });

  it("stays within [0, 360)", () => {
    for (const p of ["/a", "/b/c", "C:\\x\\y", "", "/Users/me/terax-ai"]) {
      const h = hashHue(p);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("distinguishes different folders", () => {
    expect(hashHue("/Users/me/a")).not.toBe(hashHue("/Users/me/b"));
  });
});

describe("resolveHue", () => {
  it("hashes the folder when there is no override", () => {
    const tab = terminalTab({ cwd: "/Users/me/proj" });
    expect(resolveHue(tab)).toBe(hashHue("/Users/me/proj"));
  });

  it("prefers an explicit override over the folder hash", () => {
    const tab = terminalTab({ cwd: "/Users/me/proj", colorHue: 200 });
    expect(resolveHue(tab)).toBe(200);
  });

  it("treats a 0 override as a real value, not absent", () => {
    const tab = terminalTab({ cwd: "/Users/me/proj", colorHue: 0 });
    expect(resolveHue(tab)).toBe(0);
  });

  it("returns null when there is no override and no folder", () => {
    expect(resolveHue(terminalTab())).toBeNull();
  });

  it("returns null for a preview tab", () => {
    const tab: PreviewTab = {
      id: 1,
      kind: "preview",
      title: "example.com",
      url: "https://example.com",
    };
    expect(resolveHue(tab)).toBeNull();
  });
});
