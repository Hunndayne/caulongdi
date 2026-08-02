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
  // Tài khoản nhận tiền CHUNG của nhóm — KHÁC HOÀN TOÀN tài khoản cá nhân trong profile.
  // Tài khoản cá nhân dùng cho chiều hoàn tiền lại người ứng chi phí.
  groupBankBin?: string | null;
  groupBankAccountNumber?: string | null;
  groupBankAccountName?: string | null;
  /** Nhóm đã cấu hình hũ Timo → thanh toán thu về nhóm có thể tự xác nhận. */
  timoEnabled?: boolean;
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

// Cài đặt thanh toán của nhóm: tài khoản nhận tiền chung + hũ Timo (tuỳ chọn) để tự xác nhận.
/** Nhắc công nợ định kỳ vào group chat Messenger (cron worker gửi, không phải web). */
export interface GroupDebtReminder {
  enabled: boolean;
  /** Giờ Việt Nam, dạng "HH:MM". */
  time: string;
  /** Chưa liên kết Messenger thì bật cũng không có nơi nhận tin. */
  messengerLinked: boolean;
}

export interface GroupPaymentSettings {
  bankBin: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  /** Đã có đủ ngân hàng + số tài khoản chung. */
  configured: boolean;
  timo: GroupTimoStatus;
  /** Cảnh báo sau khi lưu, vd số tài khoản nhóm không phải số riêng của hũ. */
  warning?: string | null;
  /** Số giao dịch đọc thử được lúc lưu link hũ. */
  txnCount?: number | null;
}

// Không có trường nào chứa mật khẩu hũ: backend chỉ trả cờ hasSecurityCode.
export interface GroupTimoStatus {
  configured: boolean;
  verifyCode: string | null;
  shareUrl: string | null;
  hasSecurityCode: boolean;
  potName: string | null;
  /** Số tài khoản RIÊNG của hũ — số tài khoản chung của nhóm nên là số này. */
  potAccount: string | null;
  /** Tài khoản CHÍNH của chủ hũ, KHÔNG phải của hũ. Dùng số này thì tiền không vào hũ. */
  potAltAccount: string | null;
  potBankLabel: string | null;
  ownerName: string | null;
  /** null = chưa đủ dữ liệu để so; false = tiền sẽ không vào hũ nên không tự xác nhận được. */
  accountMatchesPot: boolean | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  recentTxns: TimoPotTxn[];
}

export interface TimoPotTxn {
  date: string | null;
  amount: number | null;
  /** txnTitle của Timo: "Từ NGUYEN VAN A" (tiền vào) / "Đến ..." (tiền ra). */
  title: string | null;
  /** txnDesc của Timo — nội dung chuyển khoản, chứa mã CLD. */
  description: string | null;
  paymentId: string | null;
  outcome: string;
  seenAt: string;
}

export interface TimoPotCheckResult {
  throttled: boolean;
  groupId?: string;
  scanned?: number;
  confirmed?: number;
  pages?: number;
  error?: string | null;
  lastCheckedAt?: string | null;
}

// Hũ hoàn lại tiền cho người ứng chi phí. Hai bước: người rút quỹ đánh dấu đã chuyển,
// người ứng xác nhận đã nhận.
export interface PotPayback {
  memberId: string;
  name: string;
  /** Số dư ròng hũ còn nợ họ: tổng đã ứng TRỪ phần họ phải chịu (nên họ không nộp vào hũ nữa). */
  amount: number;
  transferredAt: string | null;
  transferredBy: string | null;
  confirmedAt: string | null;
  /** Số tiền lúc đánh dấu đã chuyển; lệch với amount nghĩa là chi phí đổi sau đó. */
  markedAmount: number | null;
}

export interface Member {
  id: string;
  group_id?: string;
  user_id?: string;
  name: string;
  phone?: string;
  avatar_color: string;
  is_active: number;
  is_walkin?: number;
  ref_member_id?: string | null;
  session_id?: string | null;
  created_at: string;
  user_email?: string;
  /** Tên thật trong hồ sơ. members.name chỉ là bản chụp lúc tạo nên có thể đã cũ. */
  user_name?: string | null;
  /** Ảnh đại diện thật trong hồ sơ; vãng lai/chưa có tài khoản thì rỗng. */
  user_avatar_url?: string | null;
  user_bank_bin?: string;
  user_bank_account_number?: string;
  user_bank_account_name?: string;
}

export interface Session {
  id: string;
  group_id?: string;
  created_by?: string;
  name?: string | null;
  date: string;
  start_time: string;
  end_time?: string | null;
  venue: string;
  location?: string;
  note?: string;
  status: "upcoming" | "completed";
  payment_recipient?: string | null;
  force_payment_recipient?: number;
  /** 1 = thu tiền về tài khoản chung của nhóm (hũ); 0 = về người nhận chung. */
  payment_to_pot?: number;
  managers?: string | null;
  walkin_debt_mode?: "self" | "ref";
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
  quantity?: number | null;
  type: "court" | "water" | "shuttle" | "other";
  payer_id?: string | null;   // ai trả tiền hộ; null = quỹ chung trả
  consumer_id?: string | null; // legacy: ai dùng riêng đầu tiên; null = chia đều hoặc chưa rõ
  consumer_ids?: string | null; // JSON array các người dùng riêng; null = chia đều hoặc chưa rõ
  consumer_pending?: number;   // 1 = chưa rõ ai dùng, không tính vào chia đều
}

export interface ReceiptParsedCost {
  label: string;
  unitAmount: number;
  quantity: number;
  totalAmount: number;
  type: Cost["type"];
  confidence?: number;
}

export interface ReceiptParseResult {
  merchantName?: string;
  purchasedAt?: string;
  totalAmount?: number;
  currency: "VND";
  items: ReceiptParsedCost[];
  aiUsage?: AiUsageStatus;
}

export interface AiUsageStatus {
  feature: string;
  usageDate: string;
  estimatedNeurons: number;
  requestCount: number;
  dailyBudget: number;
  reservedNeuronsPerScan: number;
  remainingNeurons: number;
  enabled: boolean;
  resetAt: string;
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

export interface ChatMessage {
  id: string;
  groupId: string;
  userId: string;
  body: string;
  createdAt: string;
  user: {
    name: string;
    email: string;
    avatarUrl?: string;
  };
}

export interface SendChatMessageResponse {
  messages: ChatMessage[];
}
