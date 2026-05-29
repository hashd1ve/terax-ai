import type { AgentNotification, AgentSession } from "./types";

/** Badge count for the bell: items that actually need the user. Waiting
 *  sessions (needs input) plus unread errors; finished is informational and
 *  never badges. */
export function bellBadgeCount(
  sessions: AgentSession[],
  notifications: AgentNotification[],
): number {
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const unreadErrors = notifications.filter(
    (n) => !n.read && n.kind === "error",
  ).length;
  return waiting + unreadErrors;
}
