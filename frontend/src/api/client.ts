import type { Member, Session, SessionDetail, Cost, Payment, StatsResponse, UserProfile, ProfileUpdateInput } from "@/types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  // Members
  getMembers: () => request<Member[]>("/api/members"),
  createMember: (data: Partial<Member>) =>
    request<Member>("/api/members", { method: "POST", body: JSON.stringify(data) }),
  updateMember: (id: string, data: Partial<Member>) =>
    request<Member>(`/api/members/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteMember: (id: string) =>
    request<{ success: boolean }>(`/api/members/${id}`, { method: "DELETE" }),

  // Sessions
  getSessions: () => request<Session[]>("/api/sessions"),
  createSession: (data: Partial<Session>) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(data) }),
  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  updateSession: (id: string, data: Partial<Session>) =>
    request<Session>(`/api/sessions/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSession: (id: string) =>
    request<{ success: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),

  // Session members & costs
  setSessionMembers: (id: string, memberIds: string[]) =>
    request<{ success: boolean }>(`/api/sessions/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ memberIds }),
    }),
  addCost: (sessionId: string, data: Partial<Cost>) =>
    request<Cost>(`/api/sessions/${sessionId}/costs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteCost: (sessionId: string, costId: string) =>
    request<{ success: boolean }>(`/api/sessions/${sessionId}/costs/${costId}`, { method: "DELETE" }),
  recalculate: (sessionId: string) =>
    request<Payment[]>(`/api/sessions/${sessionId}/recalculate`, { method: "POST" }),

  // Payments
  togglePayment: (id: string) =>
    request<Payment>(`/api/payments/${id}/toggle`, { method: "POST" }),

  // Stats
  getStats: () => request<StatsResponse>("/api/stats"),

  // Profiles
  getProfiles: () => request<UserProfile[]>("/api/profiles"),
  getMyProfile: () => request<UserProfile>("/api/profiles/me"),
  getProfile: (id: string) => request<UserProfile>(`/api/profiles/${id}`),
  updateMyProfile: (data: ProfileUpdateInput) =>
    request<UserProfile>("/api/profiles/me", { method: "PUT", body: JSON.stringify(data) }),
};
