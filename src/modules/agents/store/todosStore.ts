import { create } from "zustand";

/** One row of the Claude Code TodoWrite list, mirroring the Rust `TodoItem`. */
export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed" | (string & {});
  activeForm?: string | null;
};

type TodosStoreState = {
  /** Latest checklist per Claude session id. */
  bySession: Record<string, TodoItem[]>;
  setTodos: (sessionId: string, items: TodoItem[]) => void;
  dropSession: (sessionId: string) => void;
};

export const useTodosStore = create<TodosStoreState>((set) => ({
  bySession: {},
  setTodos: (sessionId, items) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: items } })),
  dropSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));
