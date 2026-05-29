import { describe, expect, it } from "vitest";
import { normalizeCwd } from "./SessionSwitcher";

// normalizeCwd decides whether a session's cwd matches a live terminal leaf, so
// it must canonicalize Windows separators and ignore a trailing slash. A wrong
// answer here mislabels every row (Activate vs Resume here).
describe("normalizeCwd", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeCwd("C:\\Users\\me\\proj")).toBe("C:/Users/me/proj");
  });

  it("strips a trailing slash but keeps root", () => {
    expect(normalizeCwd("/Users/me/proj/")).toBe("/Users/me/proj");
    expect(normalizeCwd("/")).toBe("/");
  });

  it("leaves an already-normalized path untouched", () => {
    expect(normalizeCwd("/Users/me/proj")).toBe("/Users/me/proj");
  });

  it("matches a mixed-separator path against a forward-slash one", () => {
    expect(normalizeCwd("C:\\a\\b\\")).toBe(normalizeCwd("C:/a/b"));
  });
});
