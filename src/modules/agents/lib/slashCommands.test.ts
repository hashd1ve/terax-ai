import { describe, expect, it } from "vitest";
import { deriveCommandName } from "./slashCommands";
import type { DirEntry } from "@/modules/system/native";

function entry(name: string, kind: DirEntry["kind"]): DirEntry {
  return { name, kind, size: 0, mtime: 0 };
}

describe("deriveCommandName", () => {
  it("strips the .md extension from a command file", () => {
    expect(deriveCommandName(entry("review.md", "file"))).toBe("review");
    expect(deriveCommandName(entry("ship-it.MD", "file"))).toBe("ship-it");
  });

  it("uses the folder name for a skill directory", () => {
    expect(deriveCommandName(entry("deep-research", "dir"))).toBe(
      "deep-research",
    );
  });

  it("ignores non-markdown files", () => {
    expect(deriveCommandName(entry("notes.txt", "file"))).toBeNull();
    expect(deriveCommandName(entry("config.json", "file"))).toBeNull();
  });

  it("ignores dotfiles and dot-directories", () => {
    expect(deriveCommandName(entry(".keep", "file"))).toBeNull();
    expect(deriveCommandName(entry(".git", "dir"))).toBeNull();
  });

  it("ignores symlinks", () => {
    expect(deriveCommandName(entry("link.md", "symlink"))).toBeNull();
  });

  it("returns null for an empty derived name", () => {
    expect(deriveCommandName(entry(".md", "file"))).toBeNull();
  });
});
