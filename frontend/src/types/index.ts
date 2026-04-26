export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  role: "admin" | "member";
  createdAt: string;
}

export interface UserProfile extends User {
  phone?: string;
  bio?: string;
  birthday?: string;
  location?: string;
  updatedAt: string;
}

export interface ProfileUpdateInput {
  name?: string;
  phone?: string;
  bio?: string;
  birthday?: string;
  location?: string;
  avatarUrl?: string;
}

export interface PlayGroup {
  id: string;
  name: string;
  description?: string;
  ownerUserId: string;
  role: "admin" | "member";
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  group_id?: string;
  user_id?: string;
  name: string;
  phone?: string;
  avatar_color: string;
  is_active: number;
  created_at: string;
}

export interface Session {
  id: string;
  group_id?: string;
  created_by?: string;
  date: string;
  start_time: string;
  venue: string;
  location?: string;
  note?: string;
  status: "upcoming" | "completed";
  created_at: string;
  attendee_count?: number;
  total_cost?: number;
}

export interface SessionDetail extends Session {
  members: (Member & { attended: number })[];
  costs: Cost[];
  payments: Payment[];
}

export interface Cost {
  id: string;
  session_id: string;
  label: string;
  amount: number;
  type: "court" | "water" | "shuttle" | "other";
}

export interface Payment {
  id: string;
  session_id: string;
  member_id: string;
  amount_owed: number;
  paid: number;
  paid_at?: string;
}

export interface MemberStats {
  memberId: string;
  memberName: string;
  avatarColor: string;
  attendCount: number;
  totalOwed: number;
  totalPaid: number;
  debt: number;
}

export interface StatsResponse {
  totalSessions: number;
  memberStats: MemberStats[];
  monthlyStats: { month: string; session_count: number; total_cost: number }[];
}
