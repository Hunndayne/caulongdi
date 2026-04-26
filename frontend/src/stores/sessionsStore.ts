import { create } from "zustand";
import { api } from "@/api/client";
import type { Session, SessionDetail } from "@/types";

interface SessionsState {
  sessions: Session[];
  currentSession: SessionDetail | null;
  loading: boolean;
  fetch: (groupId?: string) => Promise<void>;
  fetchOne: (id: string) => Promise<void>;
  create: (data: Partial<Session>) => Promise<Session>;
  update: (id: string, data: Partial<Session>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  currentSession: null,
  loading: false,

  fetch: async (groupId) => {
    set({ loading: true });
    try {
      const sessions = await api.getSessions(groupId);
      set({ sessions });
    } finally {
      set({ loading: false });
    }
  },

  fetchOne: async (id) => {
    set({ loading: true });
    try {
      const session = await api.getSession(id);
      set({ currentSession: session });
    } finally {
      set({ loading: false });
    }
  },

  create: async (data) => {
    const session = await api.createSession(data);
    set((s) => ({ sessions: [session, ...s.sessions] }));
    return session;
  },

  update: async (id, data) => {
    const updated = await api.updateSession(id, data);
    set((s) => ({
      sessions: s.sessions.map((sess) => (sess.id === id ? updated : sess)),
      currentSession: s.currentSession?.id === id ? { ...s.currentSession, ...updated } : s.currentSession,
    }));
  },

  remove: async (id) => {
    await api.deleteSession(id);
    set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
  },

  refresh: async (id) => {
    const session = await api.getSession(id);
    set({ currentSession: session });
  },
}));
