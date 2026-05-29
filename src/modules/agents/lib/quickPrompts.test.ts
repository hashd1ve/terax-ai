import { describe, expect, it } from "vitest";
import { fillPlaceholders } from "./quickPrompts";

describe("fillPlaceholders", () => {
  it("substitutes every placeholder when all values are present", () => {
    expect(
      fillPlaceholders("Explain {{file}} on {{branch}}: {{selection}}", {
        file: "src/a.ts",
        branch: "feat/x",
        selection: "foo()",
      }),
    ).toBe("Explain src/a.ts on feat/x: foo()");
  });

  it("drops a missing token and tidies the surrounding whitespace", () => {
    expect(
      fillPlaceholders("Refactor {{selection}} for readability.", {
        selection: null,
      }),
    ).toBe("Refactor for readability.");
  });

  it("drops a missing token at the end and trims", () => {
    expect(
      fillPlaceholders("Summarize what changed on this branch {{branch}}.", {
        branch: undefined,
      }),
    ).toBe("Summarize what changed on this branch .");
  });

  it("treats an empty string value as missing", () => {
    expect(fillPlaceholders("Explain {{file}} now", { file: "" })).toBe(
      "Explain now",
    );
  });

  it("returns the body unchanged when it has no placeholders", () => {
    expect(fillPlaceholders("Review the staged diff for bugs.", {})).toBe(
      "Review the staged diff for bugs.",
    );
  });

  it("replaces every occurrence of a repeated placeholder", () => {
    expect(
      fillPlaceholders("Compare {{file}} with {{file}} again", {
        file: "a.ts",
      }),
    ).toBe("Compare a.ts with a.ts again");
  });

  it("collapses runs of whitespace left by adjacent dropped tokens", () => {
    expect(
      fillPlaceholders("Look at {{file}} {{selection}} here", {
        file: null,
        selection: null,
      }),
    ).toBe("Look at here");
  });
});
