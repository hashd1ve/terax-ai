export type QuickPrompt = { id: string; label: string; body: string };

export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: "explain-file",
    label: "Explain file",
    body: "Explain what {{file}} does and how it fits into the codebase.",
  },
  {
    id: "write-tests",
    label: "Write tests for file",
    body: "Write tests for {{file}}, covering edge cases and failure modes.",
  },
  {
    id: "review-staged",
    label: "Review staged diff for bugs",
    body: "Review the staged diff for bugs, focusing on correctness and edge cases.",
  },
  {
    id: "refactor-selection",
    label: "Refactor selection for readability",
    body: "Refactor {{selection}} for readability without changing behavior.",
  },
  {
    id: "summarize-branch",
    label: "Summarize branch changes",
    body: "Summarize what changed on this branch {{branch}} versus its base.",
  },
];

export type PromptContext = {
  file?: string | null;
  branch?: string | null;
  selection?: string | null;
};

const PLACEHOLDER = /\{\{(file|branch|selection)\}\}/g;

/**
 * Substitute {{file}}/{{branch}}/{{selection}} in `body` with values from
 * `ctx`. A missing value drops its token entirely rather than leaving an empty
 * "()" or a stray placeholder; leftover double spaces are collapsed and the
 * result is trimmed so the staged prompt reads cleanly.
 */
export function fillPlaceholders(body: string, ctx: PromptContext): string {
  const filled = body.replace(PLACEHOLDER, (_match, key: keyof PromptContext) => {
    const value = ctx[key];
    return value ? value : "";
  });
  return filled.replace(/\s{2,}/g, " ").trim();
}
