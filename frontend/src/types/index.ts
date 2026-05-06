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
  bankBin?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  updatedAt: string;
}

export interface ProfileUpdateInput {
  name?: string;
  phone?: string;
  bio?: string;
  birthday?: string;
  location?: string;
  avatarUrl?: string;
  bankBin?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
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

export interface GroupMember {
  userId: string;
  role: "admin" | "member";
  joinedAt: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface GroupInvite {
  id: string;
  groupId: string;
  groupName: string;
  groupDescription?: string;
  invitedUserId: string;
  invitedUserName?: string;
  invitedUserEmail?: string;
  invitedUserAvatarUrl?: string;
  invitedByUserId: string;
  invitedByName: string;
  invitedByEmail: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "declined";
  createdAt: string;
  respondedAt?: string;
}

export interface GroupSearchResult {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  inviteStatus: "none" | "pending";
  pendingInviteId?: string;
}

export interface GroupInviteLink {
  code: string;
  role: "admin" | "member";
  maxUses?: number | null;
  useCount: number;
  expiresAt?: string;
  createdAt: string;
}

export interface JoinLinkPreview {
  groupId: string;
  groupName: string;
  groupDescription?: string;
  role: string;
  memberCount: number;
  alreadyMember: boolean;
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
  user_email?: string;
  user_bank_bin?: string;
  user_bank_account_number?: string;
  user_bank_account_name?: string;
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
  payment_recipient?: string | null;
  managers?: string | null;
  allow_all_edit?: number;
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
  payer_id?: string | null;   // ai trả tiền hộ; null = quỹ chung trả
  consumer_id?: string | null; // ai dùng riêng; null = chia đều hoặc chưa rõ
  consumer_pending?: number;   // 1 = chưa rõ ai dùng, không tính vào chia đều
}

export interface Payment {
  id: string;
  session_id: string;
  member_id: string;
  recipient_member_id?: string | null;
  amount_owed: number;
  payer_marked_paid?: number;
  payer_marked_paid_at?: string;
  paid: number;
  paid_at?: string;
}

export interface MemberStats {
  memberId: string;
  userId?: string;
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
