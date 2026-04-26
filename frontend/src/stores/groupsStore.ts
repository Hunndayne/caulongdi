import { create } from "zustand";
import { api } from "@/api/client";
import type { PlayGroup } from "@/types";

const ACTIVE_GROUP_KEY = "caulong.activeGroupId";

interface GroupsState {
  groups: PlayGroup[];
  activeGroupId?: string;
  loading: boolean;
  error?: string;
  fetch: () => Promise<void>;
  createGroup: (data: { name: string; description?: string }) => Promise<PlayGroup>;
  setActiveGroup: (id?: string) => void;
}

function readActiveGroupId() {
  if (typeof localStorage === "undefined") return undefined;
  return localStorage.getItem(ACTIVE_GROUP_KEY) ?? undefined;
}

function writeActiveGroupId(id?: string) {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_GROUP_KEY, id);
  else localStorage.removeItem(ACTIVE_GROUP_KEY);
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: [],
  activeGroupId: readActiveGroupId(),
  loading: false,

  fetch: async () => {
    set({ loading: true, error: undefined });
    try {
      const groups = await api.getGroups();
      const current = get().activeGroupId;
      const activeGroupId = groups.some((group) => group.id === current) ? current : groups[0]?.id;
      writeActiveGroupId(activeGroupId);
      set({ groups, activeGroupId });
    } catch (error) {
      set({
        groups: [],
        activeGroupId: undefined,
        error: error instanceof Error ? error.message : "Không tải được nhóm chơi",
      });
    } finally {
      set({ loading: false });
    }
  },

  createGroup: async (data) => {
    const group = await api.createGroup(data);
    writeActiveGroupId(group.id);
    set((state) => ({
      groups: [group, ...state.groups.filter((item) => item.id !== group.id)],
      activeGroupId: group.id,
      error: undefined,
    }));
    return group;
  },

  setActiveGroup: (id) => {
    writeActiveGroupId(id);
    set({ activeGroupId: id });
  },
}));
