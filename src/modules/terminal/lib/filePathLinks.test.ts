import { describe, expect, it } from "vitest";
import { parsePathTokens, resolveLeafPath } from "./filePathLinks";

describe("parsePathTokens", () => {
  it("detects a workspace-relative path with line and col", () => {
    const [m] = parsePathTokens("see src/app/App.tsx:1341:5 for details");
    expect(m).toMatchObject({
      path: "src/app/App.tsx",
      line: 1341,
      col: 5,
      text: "src/app/App.tsx:1341:5",
    });
  });

  it("detects a path with only a line suffix", () => {
    const [m] = parsePathTokens("error at src/app/App.tsx:42");
    expect(m).toMatchObject({ path: "src/app/App.tsx", line: 42 });
    expect(m.col).toBeUndefined();
  });

  it("detects an absolute path", () => {
    const [m] = parsePathTokens("opening /abs/path/file.rs now");
    expect(m).toMatchObject({ path: "/abs/path/file.rs", text: "/abs/path/file.rs" });
    expect(m.line).toBeUndefined();
  });

  it("detects an explicitly relative path", () => {
    const [m] = parsePathTokens("./rel/file.ts:10:5");
    expect(m).toMatchObject({ path: "./rel/file.ts", line: 10, col: 5 });
  });

  it("detects a parent-relative path", () => {
    const [m] = parsePathTokens("../sibling/mod.rs");
    expect(m).toMatchObject({ path: "../sibling/mod.rs" });
  });

  it("detects a bare filename with a known extension", () => {
    const [m] = parsePathTokens("edit App.tsx please");
    expect(m).toMatchObject({ path: "App.tsx" });
  });

  it("reports correct start/end indices for column ranges", () => {
    const line = "xx src/a.ts:9 yy";
    const [m] = parsePathTokens(line);
    expect(line.slice(m.startIndex, m.endIndex)).toBe("src/a.ts:9");
    expect(m.startIndex).toBe(3);
    expect(m.endIndex).toBe(13);
  });

  it("trims trailing prose punctuation", () => {
    const [m] = parsePathTokens("see (src/app.ts).");
    expect(m.path).toBe("src/app.ts");
    expect(m.text).toBe("src/app.ts");
  });

  it("does not linkify bare prose words", () => {
    expect(parsePathTokens("just some normal words here")).toHaveLength(0);
  });

  it("does not treat a bare time like 12:34 as a path", () => {
    expect(parsePathTokens("at 12:34 today")).toHaveLength(0);
  });

  it("does not linkify a bare word without a known extension", () => {
    expect(parsePathTokens("README and Makefile")).toHaveLength(0);
  });

  it("finds multiple paths on one line", () => {
    const ms = parsePathTokens("src/a.ts and /tmp/b.rs:3");
    expect(ms).toHaveLength(2);
    expect(ms[0].path).toBe("src/a.ts");
    expect(ms[1]).toMatchObject({ path: "/tmp/b.rs", line: 3 });
  });

  it("handles a dir/file path with no extension", () => {
    const [m] = parsePathTokens("look in src/components/Button");
    expect(m?.path).toBe("src/components/Button");
  });

  it("detects a dotfile by its extension", () => {
    const [m] = parsePathTokens("check .env now");
    expect(m?.path).toBe(".env");
  });

  it("does not linkify any fragment of an http(s) URL", () => {
    expect(parsePathTokens("See https://example.com/foo/bar for details")).toHaveLength(0);
    expect(parsePathTokens("Docs at http://localhost:3000/api/v1 here")).toHaveLength(0);
  });

  it("does not linkify a path-shaped tail inside a URL", () => {
    // The github URL ends in something that looks like `src/app.ts:10`, but it
    // belongs to the URL — the WebLinksAddon owns it.
    expect(
      parsePathTokens("ref https://github.com/org/repo/blob/main/src/app.ts:10"),
    ).toHaveLength(0);
  });

  it("still linkifies a real path that sits next to a URL", () => {
    const ms = parsePathTokens("https://x.com and ./local.ts:4");
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ path: "./local.ts", line: 4 });
  });
});

describe("resolveLeafPath", () => {
  it("returns absolute paths normalized", () => {
    expect(resolveLeafPath("/a/b/../c/file.ts", "/cwd")).toBe("/a/c/file.ts");
  });

  it("joins relative paths against the cwd", () => {
    expect(resolveLeafPath("src/app.ts", "/home/me/proj")).toBe(
      "/home/me/proj/src/app.ts",
    );
  });

  it("resolves ./ relative paths against the cwd", () => {
    expect(resolveLeafPath("./a/b.ts", "/cwd")).toBe("/cwd/a/b.ts");
  });

  it("resolves ../ relative paths against the cwd", () => {
    expect(resolveLeafPath("../x.ts", "/home/me/proj")).toBe("/home/me/x.ts");
  });

  it("expands ~/ against home", () => {
    expect(resolveLeafPath("~/notes.md", "/cwd", "/home/me")).toBe(
      "/home/me/notes.md",
    );
  });

  it("returns null for a relative path with no cwd", () => {
    expect(resolveLeafPath("src/app.ts", null)).toBeNull();
  });

  it("returns absolute paths even without a cwd", () => {
    expect(resolveLeafPath("/abs/x.ts", null)).toBe("/abs/x.ts");
  });
});
