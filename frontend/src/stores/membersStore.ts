import { create } from "zustand";
import { api } from "@/api/client";
import type { Member } from "@/types";

interface MembersState {
  members: Member[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (data: Partial<Member>) => Promise<Member>;
  update: (id: string, data: Partial<Member>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useMembersStore = create<MembersState>((set, get) => ({
  members: [],
  loading: false,

  fetch: async () => {
    set({ loading: true });
    try {
      const members = await api.getMembers();
      set({ members });
    } finally {
      set({ loading: false });
    }
  },

  create: async (data) => {
    const member = await api.createMember(data);
    set((s) => ({ members: [...s.members, member] }));
    return member;
  },

  update: async (id, data) => {
    const updated = await api.updateMember(id, data);
    set((s) => ({ members: s.members.map((m) => (m.id === id ? updated : m)) }));
  },

  remove: async (id) => {
    await api.deleteMember(id);
    set((s) => ({ members: s.members.filter((m) => m.id !== id) }));
  },
}));
