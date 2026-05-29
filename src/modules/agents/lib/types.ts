export type AgentStatus = "working" | "waiting" | "done";

export type AgentSource = "terminal";

export type AgentSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "error"
  | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent: string | null;
};

export type AgentSession = {
  leafId: number;
  tabId: number;
  agent: string;
  status: AgentStatus;
  startedAt: number;
  lastActivityAt: number;
  attentionSince: number | null;
  /** Conversation title (ai-title), resolved lazily from the transcript. */
  title?: string;
  /** The user's last prompt, shown only on the live needs-input row. */
  lastPrompt?: string;
};

export type AgentNotification = {
  id: string;
  source: AgentSource;
  leafId: number;
  tabId: number;
  agent: string;
  /** Conversation title snapshot, kept so history rows survive the session. */
  title?: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
};

export type NotificationKind = "attention" | "finished" | "error";
