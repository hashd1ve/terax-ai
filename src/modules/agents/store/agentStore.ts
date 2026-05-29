import { create } from "zustand";
import type {
  AgentNotification,
  AgentSession,
  AgentStatus,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string) => void;
  setStatus: (leafId: number, status: AgentStatus) => void;
  setContext: (leafId: number, ctx: { title?: string | null; lastPrompt?: string | null }) => void;
  upsertFinished: (n: { leafId: number; tabId: number; agent: string; title?: string }) => void;
  finish: (leafId: number) => void;
  pushNotification: (
    n: Omit<AgentNotification, "id" | "at" | "read">,
  ) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  notifications: [],

  start: (leafId, tabId, agent) =>
    set((s) => {
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
      };
    }),

  setStatus: (leafId, status) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev || prev.status === status) return s;
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
          },
        },
      };
    }),

  setContext: (leafId, ctx) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev) return s;
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            ...(ctx.title ? { title: ctx.title } : {}),
            ...(ctx.lastPrompt ? { lastPrompt: ctx.lastPrompt } : {}),
          },
        },
      };
    }),

  upsertFinished: ({ leafId, tabId, agent, title }) =>
    set((s) => {
      const now = Date.now();
      const idx = s.notifications.findIndex(
        (n) => n.kind === "finished" && n.leafId === leafId,
      );
      const rest =
        idx >= 0 ? s.notifications.filter((_, i) => i !== idx) : s.notifications;
      const row =
        idx >= 0
          ? { ...s.notifications[idx], at: now, read: false, title, tabId, agent }
          : {
              id: `n${++notifSeq}`,
              source: "terminal" as const,
              leafId,
              tabId,
              agent,
              kind: "finished" as const,
              title,
              at: now,
              read: false,
            };
      return { notifications: [row, ...rest].slice(0, MAX_NOTIFICATIONS) };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      return { sessions: next };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) };
    }),

  clearNotifications: () => set({ notifications: [] }),
}));
