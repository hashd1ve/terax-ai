import { writeToSession } from "@/modules/terminal";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { toast } from "sonner";

export type AgentRefRange = { startLine: number; endLine: number };

/**
 * Build a Claude Code @-reference for a file, optionally with a line range.
 *
 * The returned string is padded with a single leading and trailing space so it
 * inserts cleanly between existing prompt text. The range suffix uses Claude's
 * `#L<start>` / `#L<start>-<end>` syntax (not the colon form). When `agentCwd`
 * is a non-empty prefix of `absPath`, the path is relativized against it;
 * otherwise the absolute path is used. Never emits a newline or carriage
 * return so the agent prompt stays staged rather than auto-submitted.
 */
export function buildAgentRef(
  absPath: string,
  agentCwd?: string | null,
  range?: AgentRefRange | null,
): string {
  const path = relativize(absPath, agentCwd);
  let suffix = "";
  if (range) {
    suffix =
      range.startLine === range.endLine
        ? `#L${range.startLine}`
        : `#L${range.startLine}-${range.endLine}`;
  }
  return ` @${path}${suffix} `;
}

function relativize(absPath: string, agentCwd?: string | null): string {
  if (!agentCwd) return absPath;
  const cwdParts = agentCwd.split(/[\\/]/).filter(Boolean);
  const pathParts = absPath.split(/[\\/]/).filter(Boolean);
  if (cwdParts.length === 0 || cwdParts.length > pathParts.length) {
    return absPath;
  }
  for (let i = 0; i < cwdParts.length; i++) {
    if (cwdParts[i] !== pathParts[i]) return absPath;
  }
  return pathParts.slice(cwdParts.length).join("/");
}

/**
 * Stage `text` into the PTY of the most-recently-active Claude session, falling
 * back to `fallbackLeafId` when no agent session is tracked. Prefers an idle
 * session (waiting or done) over one still "working", breaking ties by recency.
 * Returns true when the text was written, false (with a toast) otherwise.
 */
export function sendToActiveAgent(
  text: string,
  fallbackLeafId: number | null,
): boolean {
  const leafId = pickAgentLeafId(fallbackLeafId);
  if (leafId === null) {
    toast("No active Claude session or terminal");
    return false;
  }
  return writeToSession(leafId, text);
}

/**
 * Resolve the leaf that should receive a handoff: the most-recently-active
 * agent session (preferring an idle session, waiting or done, over one still
 * working), or `fallbackLeafId` when no session is tracked.
 */
export function pickAgentLeafId(fallbackLeafId: number | null): number | null {
  const sessions = Object.values(useAgentStore.getState().sessions);
  if (sessions.length === 0) return fallbackLeafId;
  const best = sessions.reduce((acc, s) => {
    const accReady = acc.status !== "working";
    const sReady = s.status !== "working";
    if (sReady !== accReady) return sReady ? s : acc;
    return s.lastActivityAt > acc.lastActivityAt ? s : acc;
  });
  return best.leafId;
}
