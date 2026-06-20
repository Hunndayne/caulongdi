import { Hono } from "hono";
import { Env } from "../types";
import { ensureBotTables } from "../db/botTables";
import { recalcSessionPayments } from "./sessions";

// Router cho Messenger userbot (server riêng gọi vào).
// Xác thực bằng Bearer BOT_SERVICE_SECRET (DDNS nên không allowlist IP được).
// Bot phía Facebook chỉ làm I/O: forward {threadId, senderName, text} -> nhận {ok, reply} rồi gửi lại chat.

const bot = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MAX_SESSIONS_IN_REPLY = 8;

type Intent =
  | "help"
  | "next"
  | "upcoming"
  | "today"
  | "week"
  | "recent"
  | "list_members"
  | "list_attendees"
  | "add_member"
  | "remove_member"
  | "create_session"
  | "update_session"
  | "cancel_session"
  | "costs"
  | "add_cost"
  | "mark_paid"
  | "stats"
  | "chat";

type SessionDraft = {
  date?: string;
  startTime?: string;
  venue?: string;
  note?: string;
};

type CostDraft = {
  label?: string;
  amount?: number;
  quantity?: number;
  payerName?: string;
  consumerNames?: string[];
};

type ParsedIntent = {
  intent: Intent;
  names: string[];
  session?: SessionDraft;
  cost?: CostDraft;
  // update_session: session = buổi đang nói tới (giá trị cũ), changes = giá trị mới
  changes?: SessionDraft;
};

type BotContextMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
};

type SessionRow = {
  id: string;
  name?: string | null;
  date: string;
  start_time: string;
  end_time?: string | null;
  venue: string;
  location?: string | null;
  note?: string | null;
  status: string;
  attendee_count: number;
};

export type BotReply = { ok: boolean; reply: string };

type BotActor = {
  userId?: string;
  name?: string | null;
  // members.id đã ghép qua /alias — ưu tiên khi resolve "tôi/mình" từ Messenger.
  memberId?: string;
};

const SELF_NAME_TOKEN = "__ting_self__";
const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
const MAX_CONTEXT_MESSAGES_FOR_AI = 8;

function bearerToken(header?: string | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

// NFD không tách "đ" (U+0111) nên xử lý thủ công.
function removeDiacritics(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// Giờ Việt Nam (UTC+7) để hiểu "hôm nay" / "tuần này".
function vnNow() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function vnToday() {
  return vnNow().toISOString().slice(0, 10);
}

function vnDateAfter(days: number) {
  const date = vnNow();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextVnWeekday(targetWeekday: number) {
  const now = vnNow();
  const current = now.getUTCDay();
  const delta = (targetWeekday - current + 7) % 7 || 7;
  now.setUTCDate(now.getUTCDate() + delta);
  return now.toISOString().slice(0, 10);
}

function vnWeekRange() {
  const now = vnNow();
  const weekday = now.getUTCDay(); // 0=CN..6=T7 trên mốc đã dời sang giờ VN
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function statusLabel(status: string) {
  if (status === "completed") return "Đã xong";
  if (status === "upcoming") return "Sắp diễn ra";
  return status;
}

function sessionTitle(s: SessionRow) {
  return s.name?.trim() || s.venue;
}

function sessionTimeRange(s: SessionRow) {
  return s.end_time ? `${s.start_time} - ${s.end_time}` : s.start_time;
}

function formatSession(s: SessionRow) {
  const lines = [`🏸 ${formatDate(s.date)} • ${sessionTimeRange(s)} • ${sessionTitle(s)}`];
  if (s.venue && s.venue !== sessionTitle(s)) lines.push(`Sân: ${s.venue}`);
  if (s.location) lines.push(`📍 ${s.location}`);
  const status = s.status && s.status !== "upcoming" ? ` • ${statusLabel(s.status)}` : "";
  lines.push(`👥 ${s.attendee_count} người${status}`);
  if (s.note) lines.push(`📝 ${s.note}`);
  return lines.join("\n");
}

function sessionSummaryLine(s: SessionRow) {
  return `${formatDate(s.date)} • ${sessionTimeRange(s)} • ${sessionTitle(s)}`;
}

async function getAttendeeNames(env: Env, sessionId: string): Promise<string[]> {
  const result = await env.DB
    .prepare(
      `SELECT m.name FROM session_members sm
       JOIN members m ON m.id = sm.member_id
       WHERE sm.session_id = ? AND sm.attended = 1
       ORDER BY m.is_walkin ASC, m.name COLLATE NOCASE`
    )
    .bind(sessionId)
    .all<{ name: string }>();
  return (result.results ?? []).map((r) => r.name);
}

// Hiển thị buổi kèm danh sách người tham gia (giống giao diện trên web/app) —
// truy vấn buổi là show luôn ai đi, không cần hỏi thêm.
async function formatSessionDetailed(env: Env, s: SessionRow): Promise<string> {
  const lines = [`🏸 ${formatDate(s.date)} • ${sessionTimeRange(s)} • ${sessionTitle(s)}`];
  if (s.venue && s.venue !== sessionTitle(s)) lines.push(`Sân: ${s.venue}`);
  if (s.location) lines.push(`📍 ${s.location}`);
  const status = s.status && s.status !== "upcoming" ? ` • ${statusLabel(s.status)}` : "";
  const names = await getAttendeeNames(env, s.id);
  if (names.length) {
    lines.push(`👥 ${names.length} người tham gia${status}:`);
    for (const name of names) lines.push(`• ${name}`);
  } else {
    lines.push(`👥 ${s.attendee_count ?? 0} người${status}`);
  }
  if (s.note) lines.push(`📝 ${s.note}`);
  return lines.join("\n");
}

// Khoá can thiệp khi đã chia tiền VÀ có ít nhất 1 người chuyển xong (paid = 1 / "Đã xong").
// Chỉ chia tiền mà chưa ai chuyển thì vẫn cho bot chỉnh để linh động.
async function sessionHasPaidTransfer(env: Env, sessionId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT 1 AS n FROM payments WHERE session_id = ? AND paid = 1 LIMIT 1")
    .bind(sessionId)
    .first<{ n: number }>();
  return Boolean(row);
}

const PAID_LOCK_REPLY =
  "Buổi này đã có người chuyển tiền (trạng thái Đã xong) nên mình không chỉnh được nữa — cần thay đổi thì thao tác trên web nhé.";

function formatMoney(amount: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Math.round(Number(amount) || 0));
}

function helpText() {
  return [
    "🤖 TingTing bot — các lệnh:",
    "• /play — buổi sắp tới của nhóm",
    '• "buổi hôm nay" / "buổi tuần này" / "buổi kế tiếp" — lọc theo thời gian',
    '• "các buổi gần đây" — lịch sử gần đây',
    '• "thành viên" — danh sách thành viên nhóm',
    '• "buổi sắp tới có ai" — ai tham gia buổi sắp tới',
    '• "thêm <tên> vào buổi" — thêm người vào buổi sắp tới',
    '• "bớt tôi ra" / "Nam không đi nữa" — rút người khỏi buổi',
    '• "dời kèo mai sang 19h" / "đổi sân sang Q7" — sửa buổi',
    '• "hủy kèo ngày mai" — hủy buổi (bot hỏi xác nhận trước khi xóa)',
    '• "tháng này đánh mấy buổi" / "ai đi nhiều nhất" — thống kê',
    '• "chi phí buổi vừa rồi" / "ai nợ ai" — xem tổng tiền và công nợ của buổi',
    '• "tiền sân 240k" / "3 ống cầu 270k Nam trả" — ghi khoản chi vào buổi (mặc định chia đều)',
    '• "nem nướng 348k Phát trả, chia cho Phát, Hậu, Vinh" — ghi khoản chỉ chia cho vài người',
    '• /alias <tên trên web> — ghép tên Messenger của bạn với thành viên web (để "thêm tôi" đúng người; /alias xoa để bỏ)',
    "• /connect <mã> — liên kết nhóm chat với nhóm TingTing (lấy mã trên web)",
    "• /disconnect — huỷ liên kết",
  ].join("\n");
}

function contextForPrompt(context?: BotContextMessage[]) {
  const items = (context ?? []).slice(-MAX_CONTEXT_MESSAGES_FOR_AI);
  if (!items.length) return "";

  return items
    .map((item) => {
      const who = item.role === "assistant" ? "Ting AI" : "Người dùng";
      const text = item.text.replace(/^\/ting\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 500);
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// --- Nhận diện ý định ---

// Câu "thêm người vào buổi" — nhận diện bằng regex (đáng tin) để không phụ thuộc DeepSeek đoán intent.
function isAddLike(t: string): boolean {
  return /(^|\s|\/)(them|add)(\s|$)/.test(t) || /\b(cho|dua)\b.*\b(vao|tham gia)\b.*buoi/.test(t);
}

function isCreateSessionLike(t: string): boolean {
  return (
    /\b(them|add)\b.*\b(buoi|keo)\b.*\bmoi\b/.test(t) ||
    /\b(tao|set|lap|len|mo)\b.*\b(buoi|keo|lich)\b/.test(t) ||
    /\b(buoi|keo)\s+moi\b/.test(t)
  );
}

function parseCreateDate(text: string): string | undefined {
  const t = removeDiacritics(text.toLowerCase());
  if (/\bhom nay\b|\btoday\b/.test(t)) return vnToday();
  if (/\bhom qua\b|\byesterday\b/.test(t)) return vnDateAfter(-1);
  if (/\bngay mai\b|\bmai\b|\btomorrow\b/.test(t)) return vnDateAfter(1);
  if (/\bngay kia\b|\bngay mot\b|\bmot\b/.test(t) && !/\bmot\s+buoi\b/.test(t)) return vnDateAfter(2);

  const slash = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const yearRaw = slash[3] ? Number(slash[3]) : vnNow().getUTCFullYear();
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const weekdays: Array<[RegExp, number]> = [
    [/\bthu\s*(2|hai)\b/, 1],
    [/\bthu\s*(3|ba)\b/, 2],
    [/\bthu\s*(4|tu)\b/, 3],
    [/\bthu\s*(5|nam)\b/, 4],
    [/\bthu\s*(6|sau)\b/, 5],
    [/\bthu\s*(7|bay)\b/, 6],
    [/\b(chu nhat|cn|sunday)\b/, 0],
  ];
  const match = weekdays.find(([pattern]) => pattern.test(t));
  return match ? nextVnWeekday(match[1]) : undefined;
}

function parseCreateTime(text: string): string | undefined {
  const t = removeDiacritics(text.toLowerCase());
  const match =
    t.match(/\b(?:luc|vao)?\s*(\d{1,2})\s*(?:h|gio|:)\s*(\d{1,2})?\s*(sang|chieu|toi|trua|am|pm)?\b/) ||
    t.match(/\b(?:luc|vao)\s+(\d{1,2})\s*(sang|chieu|toi|trua|am|pm)\b/);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minuteRaw = match[2] && /^\d+$/.test(match[2]) ? match[2] : undefined;
  const period = (minuteRaw ? match[3] : match[2]) || "";
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  if (hour > 23 || minute > 59) return undefined;
  if ((period === "chieu" || period === "toi" || period === "pm") && hour < 12) hour += 12;
  if (period === "trua" && hour < 11) hour += 12;
  if ((period === "sang" || period === "am") && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanupVenue(value: string): string {
  return value
    .replace(/\s+(?:vào|vao|lúc|luc)\b.*$/i, "")
    .replace(/\s+(?:ngày|ngay|hôm|hom|mai|thứ|thu)\b.*$/i, "")
    .replace(/\b(?:nhé|nhe|nha|ạ|a)\b/gi, " ")
    .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCreateVenue(text: string): string | undefined {
  const match = text.match(/(?:^|[\s,.;:!?])(?:ở|o|tại|tai|sân|san)\s+(.+?)(?=\s+(?:vào|vao|lúc|luc)\b|$)/i);
  const venue = match ? cleanupVenue(match[1]) : "";
  return venue || undefined;
}

function parseReferencedVenue(text: string): string | undefined {
  const direct = parseCreateVenue(text);
  if (direct) return direct;

  const match = text.match(
    /(?:buổi|buoi|kèo|keo)\s+(.+?)(?=\s+(?:ngày|ngay|hôm|hom|mai|thứ|thu|\d{1,2}[/-]|\d{1,2}\s*(?:h|giờ|gio|:)|lúc|luc|vào|vao)\b|$)/i
  );
  const venue = match ? cleanupVenue(match[1]) : "";
  if (/^\d{1,2}[/-]/.test(venue) || /^(hôm|hom|ngày|ngay|mai|thứ|thu)\b/i.test(venue)) return undefined;
  // "buổi đó/này/kia..." là đại từ chỉ buổi (resolve qua context), không phải tên sân.
  if (/^(do|nay|kia|day|nao|cu|truoc|vua roi|gan nhat|sap toi|ke tiep|tiep theo)$/.test(normalizeName(venue))) {
    return undefined;
  }
  return venue || undefined;
}

function parseContextSessionReference(context?: BotContextMessage[]): SessionDraft {
  if (!context?.length) return {};

  for (let i = context.length - 1; i >= 0; i -= 1) {
    const item = context[i];
    if (item.role !== "assistant") continue;
    const match = item.text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[•\-]\s*(\d{1,2}:\d{2})\s*[•\-]\s*([^\n]+)/);
    if (!match) continue;

    const [, day, month, year, startTime, venueRaw] = match;
    const venue = cleanupVenue(venueRaw);
    return {
      date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      startTime,
      venue: venue || undefined,
    };
  }

  return {};
}

function parseSessionReference(text: string, context?: BotContextMessage[]): SessionDraft {
  const explicit: SessionDraft = {
    date: parseCreateDate(text),
    startTime: parseCreateTime(text),
    venue: parseReferencedVenue(text),
  };

  const t = normalizeName(text);
  const canUseContext =
    /\b(buoi do|keo do|lich do|buoi nay|keo nay|lich nay|vua roi|truoc do)\b/.test(t) ||
    (!explicit.date && !explicit.startTime && !explicit.venue);
  if (!canUseContext) return explicit;

  const fromContext = parseContextSessionReference(context);
  return {
    date: explicit.date ?? fromContext.date,
    startTime: explicit.startTime ?? fromContext.startTime,
    venue: explicit.venue ?? fromContext.venue,
  };
}

function parseCreateSessionDraft(text: string): SessionDraft {
  return {
    date: parseCreateDate(text),
    startTime: parseCreateTime(text),
    venue: parseCreateVenue(text),
  };
}

// Tách tên dự phòng khi DeepSeek không rút được (bỏ từ lệnh + phần "vào buổi ...").
function extractAddTargetSegment(text: string): string {
  const match = text.match(/(?:^|[\s,.;:!?])(?:thêm|them|add|cho|đưa|dua)\s+(.+)$/i);
  return match?.[1]?.trim() || text.trim();
}

function isSelfReference(value: string): boolean {
  return /^(toi|minh|tui|em|anh|chi|tao|me|t)$/.test(normalizeName(value));
}

function cleanupAddNameCandidate(raw: string): string | null {
  if (raw.trim() === SELF_NAME_TOKEN) return SELF_NAME_TOKEN;
  let s = extractAddTargetSegment(raw);
  s = s.replace(/\s+(?:vào|vao|vô|vo|tham gia)\b.*$/i, "");
  s = s.replace(/\s+(?:lịch|lich|buổi|buoi)\b.*$/i, "");
  s = s.replace(/\b(?:nhé|nhe|nha|giúp|giup|hộ|ho|với|voi|ạ|a)\b/gi, " ");
  s = s.replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "").replace(/\s+/g, " ").trim();

  if (!s) return null;
  if (isSelfReference(s)) return SELF_NAME_TOKEN;

  const q = normalizeName(s);
  if (q.length > 60 || /\b(them|add|vao|vo|lich|buoi|hom nay|gan nhat|sap toi|nhe|nha|giup|ho|buon|met)\b/.test(q)) {
    return null;
  }
  return s;
}

function splitNameCandidates(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+(?:và|va|với|voi|and)\s+/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function normalizeAddNames(text: string, aiNames: string[] = []): string[] {
  const source = aiNames.length ? aiNames : [extractAddTargetSegment(text)];
  const names = source.flatMap(splitNameCandidates).map(cleanupAddNameCandidate).filter((x): x is string => Boolean(x));
  const textTargets = splitNameCandidates(extractAddTargetSegment(text))
    .map(cleanupAddNameCandidate)
    .filter((x): x is string => Boolean(x));
  if (textTargets.includes(SELF_NAME_TOKEN)) {
    names.unshift(SELF_NAME_TOKEN);
  }
  return [...new Set(names)];
}

function extractNamesHeuristic(text: string): string[] {
  return normalizeAddNames(text);
}

function cleanupNameList(values: string[]): string[] {
  return values.flatMap(splitNameCandidates).map(cleanupAddNameCandidate).filter((x): x is string => Boolean(x));
}

// "tạo kèo ... gồm có tôi và A ở thủ đức" — rút người tham gia đi kèm câu tạo buổi.
function parseCreateParticipants(text: string): string[] {
  const stopAhead = "(?=\\s+(?:ở|o|tại|tai|sân|san|lúc|luc|vào|vao|ngày|ngay|hôm|hom|thứ|thu)\\b|$)";
  const match =
    text.match(new RegExp(`(?:gồm|gom)\\s*(?:có|co)?\\s+(.+?)${stopAhead}`, "i")) ||
    text.match(new RegExp(`(?:cùng với|cung voi|cùng|cung|kèm|kem)\\s+(.+?)${stopAhead}`, "i")) ||
    text.match(new RegExp(`(?:^|[\\s,.;:!?])(?:có|co)\\s+(.+?)${stopAhead}`, "i"));
  if (!match) return [];
  // Bỏ mảnh nghi vấn lọt vào ("có ai đi không") — không phải tên người.
  return cleanupNameList([match[1]]).filter(
    (name) => name === SELF_NAME_TOKEN || !/(^|\s)(ai|khong|ko|gi|nao|dau)(\s|$)/.test(normalizeName(name))
  );
}

// "bớt Nam ra", "tôi không đi nữa" — rút tên người cần bỏ khỏi buổi (fallback khi AI không trả names).
function extractRemoveNames(text: string): string[] {
  const direct = text.match(/(?:^|[\s,.;:!?])(?:bớt|bot|rút|rut|xóa|xoa|gỡ|go|bỏ|bo)\s+(.+)$/i);
  let segment = direct?.[1] ?? "";
  if (!segment) {
    const negated = text.match(/^(.+?)\s+(?:không|khong|ko)\s+(?:đi|di|tham gia|chơi|choi|đánh|danh)/i);
    segment = negated?.[1] ?? "";
  }
  if (!segment) return [];
  segment = segment.replace(/\s+(?:ra|khỏi|khoi)\b.*$/i, "").replace(/\s+(?:buổi|buoi|kèo|keo|lịch|lich)\b.*$/i, "");
  return cleanupNameList([segment]);
}

function hasSessionContext(t: string): boolean {
  return (
    /^\/(play|buoi)\b/.test(t) ||
    /\b(buoi|keo|lich|choi|cau long|san|tap)\b/.test(t) ||
    /\b(di danh|danh cau|danh long|quanh cau|quanh long|danh o|di cau|di san|di long)\b/.test(t)
  );
}

function asksForSchedule(t: string): boolean {
  return (
    /^\/(play|buoi)\b/.test(t) ||
    /\b(lich|lich choi|lich danh|lich quanh|co lich|xem lich|hom nay|tuan nay|sap toi|sap dien ra|ke tiep|tiep theo|gan nhat)\b/.test(t) ||
    /\b(khi nao|may gio|gio nao|thoi gian|dia diem|o dau|san nao|co keo|keo nao|co buoi|buoi nao)\b/.test(t)
  );
}

function asksForAttendees(t: string): boolean {
  return (
    /\b(ai tham gia|ai danh|ai choi|ai di|co ai|co nhung ai|nhung ai)\b/.test(t) ||
    /\b(thanh vien|nguoi tham gia|nguoi choi|danh sach nguoi|doi hinh)\b/.test(t)
  );
}

function asksForGroupMembers(t: string): boolean {
  return (
    /^\/thanhvien\b/.test(t) ||
    /\b(ai trong nhom|thanh vien nhom|danh sach thanh vien|danh sach nguoi)\b/.test(t) ||
    /\bthanh vien\b/.test(t)
  );
}

function asksForCosts(t: string): boolean {
  return (
    /\b(chi phi|tong tien|tien buoi|tien san|tien nuoc|tien cau|tien bong|bill|hoa don|cost|payment)\b/.test(t) ||
    /\b(chia tien|thanh toan|cong no|ai no ai|ai tra ai|can chuyen|chuyen tien)\b/.test(t) ||
    /\b(het bao nhieu|het nhieu|bao nhieu tien|moi nguoi bao nhieu|dong bao nhieu|tra bao nhieu)\b/.test(t)
  );
}

function detectIntentByRegex(text: string): Intent | null {
  const t = removeDiacritics(text.toLowerCase()).trim();
  const sessionContext = hasSessionContext(t);
  const scheduleQuestion = asksForSchedule(t);
  if (/^\/help\b/.test(t) || /\b(huong dan|cac lenh|menu)\b/.test(t)) return "help";
  if (asksForCosts(t)) return "costs";
  if (sessionContext && asksForAttendees(t)) {
    return "list_attendees";
  }
  if (asksForGroupMembers(t) && !scheduleQuestion) return "list_members";
  if (sessionContext && (/\bhom nay\b|\btoday\b/.test(t))) return "today";
  if (sessionContext && /tuan nay|trong tuan|this week/.test(t)) return "week";
  if (sessionContext && /ke tiep|tiep theo|buoi toi|gan nhat|\bnext\b/.test(t)) return "next";
  if (sessionContext && /gan day|lich su|da choi|truoc day|tat ca|\ball\b|\brecent\b/.test(t)) return "recent";
  if (/^\/(play|buoi)\b/.test(t) || (sessionContext && (scheduleQuestion || /sap toi|sap dien ra|lich choi|upcoming/.test(t)))) {
    return "upcoming";
  }
  return null;
}

function normalizeIntent(value: unknown): Intent | null {
  const v = String(value ?? "").toLowerCase().trim();
  const valid: Intent[] = [
    "next",
    "upcoming",
    "today",
    "week",
    "recent",
    "list_members",
    "list_attendees",
    "add_member",
    "remove_member",
    "create_session",
    "update_session",
    "cancel_session",
    "costs",
    "add_cost",
    "mark_paid",
    "stats",
    "help",
    "chat",
  ];
  if ((valid as string[]).includes(v)) return v as Intent;
  if (v === "unknown" || v === "smalltalk" || v === "general") return "chat";
  return null;
}

// Hiểu tiền kiểu Việt: "240k", "1tr2", "270 nghìn", "240000đ" — fallback khi AI không trả amount.
function parseMoneyVn(text: string): number | undefined {
  const t = removeDiacritics(text.toLowerCase());
  let m = t.match(/(\d+)\s*(?:tr|trieu)\s*(\d)?(?!\d)/);
  if (m) return Number(m[1]) * 1_000_000 + (m[2] ? Number(m[2]) * 100_000 : 0);
  m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:k|nghin|ngan)\b/);
  if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 1000);
  m = t.match(/(\d{4,9})\s*(?:d|dong|vnd)\b/);
  if (m) return Number(m[1]);
  return undefined;
}

function normalizeAiDate(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

function normalizeAiTime(value: unknown): string | undefined {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

// Gọi DeepSeek (API tương thích OpenAI) để phân loại ý định + rút tên người + thông tin buổi.
async function classifyWithAI(
  env: Env,
  text: string,
  actor?: BotActor,
  context?: BotContextMessage[]
): Promise<ParsedIntent | null> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;

  const now = vnNow();
  const weekdayNames = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  const system = [
    `Hôm nay là ${weekdayNames[now.getUTCDay()]}, ngày ${vnToday()} (giờ Việt Nam).`,
    `Nếu người dùng nói tôi/mình/tui/em/anh/chị để chỉ chính người gửi, trả names ["${SELF_NAME_TOKEN}"].`,
    "Nếu người dùng muốn tạo/set/lên kèo/buổi/lịch mới, intent là create_session.",
    'Nếu muốn rút/bớt ai khỏi buổi ("bớt tôi ra", "Nam không đi nữa", "tôi bận rồi không đi được") thì intent là remove_member, names là người cần rút.',
    "Nếu muốn dời/đổi giờ/ngày/sân của buổi ĐÃ CÓ thì intent là update_session: session là buổi đang nói tới (theo thông tin cũ/ngữ cảnh), changes là giá trị MỚI muốn đổi sang.",
    'Nếu muốn hủy/xóa kèo/buổi thì intent là cancel_session — kể cả câu xác nhận ngắn ("đồng ý hủy", "ok hủy đi") ngay sau khi bot vừa hỏi xác nhận trong ngữ cảnh.',
    "Nếu hỏi thống kê tổng hợp NHIỀU buổi (đánh mấy buổi tháng này, ai đi nhiều nhất, tổng chi tiêu tháng/tuần/năm) thì intent là stats — khác costs (chi phí của MỘT buổi cụ thể).",
    'Hiểu tiếng lóng cầu lông: "quánh", "đánh cầu", "đi cầu", "đi sân", "kèo" đều nói về buổi chơi.',
    "Nếu người dùng hỏi ngắn kiểu lịch, lịch quánh, có lịch không, kèo nào, sân nào, mấy giờ thì intent là upcoming/next/today/week tuỳ mốc thời gian.",
    "Nếu câu hỏi lịch/buổi/kèo có hỏi ai, thành viên, người tham gia thì intent là list_attendees; chỉ dùng list_members khi hỏi danh sách thành viên của nhóm nói chung.",
    "Nếu người dùng HỎI chi phí, tổng tiền, bill, hóa đơn, công nợ, ai nợ ai, ai trả ai, chia tiền, mỗi người bao nhiêu thì intent là costs.",
    'Nếu người dùng BÁO/GHI một khoản chi vừa tiêu (có số tiền, vd "tiền sân 240k", "3 ống cầu 270k Nam trả", "nước hết 60k") thì intent là add_cost — phân biệt với costs là câu hỏi.',
    'Nếu người dùng muốn ĐÁNH DẤU/XÁC NHẬN đã trả tiền/đã chuyển khoản công nợ ("tôi trả Nam rồi", "đánh dấu đã trả", "Nam chuyển cho tôi rồi") thì intent là mark_paid.',
    "Only classify today/week/upcoming/next/recent/list_attendees when the user clearly asks about badminton sessions, schedule, court, or players; casual chat that happens to mention time words must be unknown.",
    "Bạn phân tích câu của người dùng về lịch chơi cầu lông của một nhóm và TRẢ VỀ JSON.",
    'Định dạng JSON: {"intent": "...", "names": ["..."], "session": {"date": "YYYY-MM-DD", "startTime": "HH:MM", "venue": "..."}, "changes": {"date": "...", "startTime": "...", "venue": "..."}, "cost": {"label": "...", "amount": 0, "quantity": 1, "payerName": "...", "consumerNames": ["..."]}}.',
    "intent là MỘT trong: next, upcoming, today, week, recent, list_members, list_attendees, add_member, remove_member, create_session, update_session, cancel_session, costs, add_cost, stats, help, unknown.",
    "Ý nghĩa: next=buổi sắp tới gần nhất; upcoming=danh sách buổi sắp tới; today=hôm nay; week=tuần này; recent=các buổi gần đây/lịch sử;",
    "list_members=liệt kê thành viên nhóm; list_attendees=ai tham gia buổi; add_member=thêm người vào buổi; create_session=tạo buổi/kèo mới; costs=xem chi phí/công nợ buổi; add_cost=ghi một khoản chi mới; mark_paid=xác nhận đã trả nợ; help=hướng dẫn; unknown=không liên quan.",
    `cost CHỈ điền khi intent=add_cost: label là tên khoản (vd "tiền sân", "ống cầu", "tiền ăn"), amount là số VND tuyệt đối (240k → 240000, 1tr2 → 1200000), quantity mặc định 1.`,
    `Trong cost, payerName là người ỨNG/TRẢ tiền: các cách nói "X trả", "X ứng", "X bao", "trả lại cho X", "gửi lại X", "lại cho X" đều nghĩa là X ứng tiền nên payerName=X ("${SELF_NAME_TOKEN}" nếu người gửi tự trả).`,
    `Trong cost, consumerNames là DANH SÁCH người được CHIA khoản này khi câu có liệt kê người hưởng ("cho A, B, C", "của A B C", "A B C ăn", "phần của A B"); nếu KHÔNG liệt kê ai cụ thể thì để consumerNames rỗng [] (chia đều cả buổi). consumerNames là người HƯỞNG, khác payerName là người trả — một người có thể vừa trả vừa nằm trong danh sách hưởng.`,
    'names điền khi intent=add_member/remove_member (người cần thêm/rút) hoặc create_session (người tham gia nhắc trong câu, vd "gồm có tôi và An"), ví dụ ["An","Bình"]. Các intent khác để names rỗng [].',
    "changes CHỈ điền khi intent=update_session.",
    "session điền khi câu nói về MỘT buổi cụ thể (tạo mới hoặc tham chiếu buổi nào đó, kể cả buổi nhắc trong ngữ cảnh trước): quy đổi 'ngày mai', 'thứ 7'... thành ngày cụ thể theo hôm nay; startTime dạng 24h; venue là tên sân/địa điểm.",
    "Trong session, trường nào người dùng (hoặc ngữ cảnh) KHÔNG nhắc tới thì BỎ QUA, tuyệt đối không tự đoán.",
    'Các từ "hiện tại", "bây giờ", "giờ này", "đang" chỉ là từ đệm — KHÔNG suy ra date/startTime từ chúng. Khi câu đã nêu rõ buổi (vd "buổi 18/6") thì chỉ điền date theo buổi đó, không thêm startTime trừ khi user nói giờ cụ thể.',
  ].join(" ");

  const contextBlock = contextForPrompt(context);

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `${contextBlock ? `Ngữ cảnh gần đây:\n${contextBlock}\n\n` : ""}Người gửi: ${
            actor?.name || actor?.userId || "không rõ"
          }\nTin nhắn hiện tại: ${text}`,
        },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      stream: false,
    }),
  });

  if (!resp.ok) {
    console.error("[bot-nlu] deepseek http", resp.status, await resp.text().catch(() => ""));
    return null;
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data?.choices?.[0]?.message?.content ?? "";
  let obj: { intent?: unknown; names?: unknown; session?: unknown };
  try {
    obj = JSON.parse(content);
  } catch {
    console.error("[bot-nlu] deepseek non-JSON", content);
    return null;
  }

  const intent = normalizeIntent(obj?.intent);
  if (!intent) return null;
  const names = Array.isArray(obj?.names)
    ? (obj.names as unknown[])
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim())
    : [];

  const parseAiDraft = (value: unknown): SessionDraft | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as { date?: unknown; startTime?: unknown; venue?: unknown };
    const venueRaw = typeof raw.venue === "string" ? cleanupVenue(raw.venue) : "";
    const draft: SessionDraft = {
      date: normalizeAiDate(raw.date),
      startTime: normalizeAiTime(raw.startTime),
      venue: venueRaw ? venueRaw.slice(0, 80) : undefined,
    };
    return draft.date || draft.startTime || draft.venue ? draft : undefined;
  };
  const session = parseAiDraft(obj?.session);
  const changes = parseAiDraft((obj as { changes?: unknown })?.changes);

  let cost: CostDraft | undefined;
  if ((obj as { cost?: unknown }).cost && typeof (obj as { cost?: unknown }).cost === "object") {
    const raw = (obj as {
      cost: { label?: unknown; amount?: unknown; quantity?: unknown; payerName?: unknown; consumerNames?: unknown };
    }).cost;
    const amount = Math.round(Number(raw.amount));
    const quantity = Math.floor(Number(raw.quantity));
    const consumerNames = Array.isArray(raw.consumerNames)
      ? (raw.consumerNames as unknown[])
          .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
          .map((n) => n.trim())
      : [];
    cost = {
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : undefined,
      amount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
      quantity: Number.isFinite(quantity) && quantity >= 1 ? quantity : undefined,
      payerName: typeof raw.payerName === "string" && raw.payerName.trim() ? raw.payerName.trim() : undefined,
      consumerNames: consumerNames.length ? consumerNames : undefined,
    };
    if (!cost.label && !cost.amount && !cost.payerName && !cost.consumerNames) cost = undefined;
  }

  return { intent, names, session, cost, changes };
}

function naturalChatFallback(groupName: string, text = "", actor?: BotActor) {
  const t = normalizeName(text);
  const name = actor?.name?.trim();

  if (/^(hi|hello|hey|chao|alo|ting)\b/.test(t)) {
    return `Chào ${name || "bạn"}! Mình đây. Bạn hỏi lịch, kèo sắp tới, ai tham gia, chi phí/công nợ, hoặc nhờ thêm người vào buổi là mình xử liền.`;
  }

  if (hasSessionContext(t) || asksForSchedule(t) || asksForCosts(t)) {
    return `Mình hiểu bạn đang hỏi về buổi của ${groupName}. Bạn nói rõ hơn một chút như "lịch sắp tới", "buổi sắp tới có ai" hoặc "chi phí buổi vừa rồi" là mình trả lời ngay.`;
  }

  if (/\b(cam on|thanks|thank you|ok|oke|duoc roi)\b/.test(t)) {
    return "Ok nè, cần xem lịch hay thêm ai vào buổi thì gọi mình tiếp nhé.";
  }

  return `Mình đây. Hiện mình trả lời chắc nhất về lịch cầu lông của ${groupName}: buổi sắp tới, tuần này, ai tham gia, chi phí/công nợ, tạo kèo mới hoặc thêm người vào buổi.`;
}

async function replyNaturalChat(
  env: Env,
  groupName: string,
  text: string,
  actor?: BotActor,
  context?: BotContextMessage[]
): Promise<BotReply> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const fallback = naturalChatFallback(groupName, text, actor);
  if (!apiKey) return { ok: true, reply: fallback };

  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const system = [
    "Bạn là Ting AI trong group chat của một nhóm cầu lông trên TingTing.",
    "Trả lời tự nhiên, thân thiện, vui vừa phải, bằng tiếng Việt.",
    "Ưu tiên câu trả lời ngắn gọn 1-4 câu, hợp văn cảnh chat nhóm.",
    "Tin nhắn này đã được chuyển đến bạn rồi; không bảo người dùng gõ lại /ting.",
    "Nếu người dùng hỏi về lịch chơi, thành viên, ai tham gia, chi phí/công nợ, hoặc thêm người vào buổi nhưng bạn không có đủ dữ liệu, hãy hỏi lại ngắn gọn để làm rõ.",
    "Không tự bịa dữ liệu lịch, công nợ, thành viên nếu không được cung cấp trong tin nhắn.",
    "TUYỆT ĐỐI KHÔNG nói rằng bạn ĐÃ thực hiện/cập nhật/ghi nhận/đánh dấu bất kỳ hành động nào — bạn không có khả năng thao tác dữ liệu; nếu người dùng yêu cầu một thao tác, hãy nói bạn chưa hỗ trợ và hướng dẫn làm trên web TingTing.",
  ].join(" ");
  const contextBlock = contextForPrompt(context);

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `${contextBlock ? `Ngữ cảnh gần đây:\n${contextBlock}\n\n` : ""}Nhóm: ${groupName}\nNgười gửi: ${
            actor?.name || actor?.userId || "không rõ"
          }\nTin nhắn hiện tại: ${text}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 450,
      stream: false,
    }),
  });

  if (!resp.ok) {
    console.error("[bot-chat] deepseek http", resp.status, await resp.text().catch(() => ""));
    return { ok: true, reply: fallback };
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return { ok: true, reply: reply ? reply.slice(0, 1600) : fallback };
}

// AI là nguồn chính cho session (hiểu "9h30 sáng mai" tự nhiên hơn); regex bù trường còn thiếu.
function mergeSession(primary?: SessionDraft, fallback?: SessionDraft): SessionDraft {
  return {
    date: primary?.date ?? fallback?.date,
    startTime: primary?.startTime ?? fallback?.startTime,
    venue: primary?.venue ?? fallback?.venue,
  };
}

function enrichAiIntent(ai: ParsedIntent, text: string, context?: BotContextMessage[]): ParsedIntent {
  if (ai.intent === "create_session") {
    const names = [...new Set([...cleanupNameList(ai.names), ...parseCreateParticipants(text)])];
    return { intent: "create_session", names, session: mergeSession(ai.session, parseCreateSessionDraft(text)) };
  }

  if (ai.intent === "add_member") {
    return {
      intent: "add_member",
      names: normalizeAddNames(text, ai.names),
      session: mergeSession(ai.session, parseSessionReference(text, context)),
    };
  }

  if (ai.intent === "list_attendees" || ai.intent === "costs" || ai.intent === "mark_paid") {
    return { ...ai, session: mergeSession(ai.session, parseSessionReference(text, context)) };
  }

  if (ai.intent === "add_cost") {
    return {
      ...ai,
      cost: { ...ai.cost, amount: ai.cost?.amount ?? parseMoneyVn(text) },
      session: mergeSession(ai.session, parseSessionReference(text, context)),
    };
  }

  if (ai.intent === "remove_member") {
    const names = ai.names.length ? cleanupNameList(ai.names) : extractRemoveNames(text);
    return { ...ai, names, session: mergeSession(ai.session, parseSessionReference(text, context)) };
  }

  if (ai.intent === "update_session" || ai.intent === "cancel_session") {
    return { ...ai, session: mergeSession(ai.session, parseSessionReference(text, context)) };
  }

  return ai;
}

// Mẫu "chắc ăn" — hẹp hơn isAddLike/isCreateSessionLike, chỉ dùng vá khi AI xếp nhầm sang chat.
function isStrongAddLike(t: string): boolean {
  return /\b(them|add|cho|dua)\b.*\b(vao|vo|tham gia)\b.*\b(buoi|keo|lich)\b/.test(t);
}

function isStrongCreateLike(t: string): boolean {
  return /\b(tao|set|lap)\b.*\b(buoi|keo)\b/.test(t) || /\b(buoi|keo)\s+moi\b/.test(t);
}

async function resolveIntent(env: Env, text: string, actor?: BotActor, context?: BotContextMessage[]): Promise<ParsedIntent> {
  const t = removeDiacritics(text.toLowerCase()).trim();

  // Lệnh "/" tường minh — quyết ngay, không cần AI.
  if (/^\/(them|add)\b/.test(t)) {
    return { intent: "add_member", names: normalizeAddNames(text), session: parseSessionReference(text, context) };
  }
  if (/^\/(play|buoi)\b/.test(t) && !text.replace(/^\/(play|buoi)\b/i, "").trim()) {
    return { intent: "upcoming", names: [] }; // chỉ gõ "/play" (hoặc "/buoi" cũ)
  }

  // AI là bộ phân loại chính — regex ép trước AI từng gây nhầm với câu nhiều thông tin
  // ("ai tạo buổi hôm qua vậy?" bị ép thành create_session).
  let ai: ParsedIntent | null = null;
  if (env.DEEPSEEK_API_KEY?.trim()) {
    try {
      ai = await classifyWithAI(env, text, actor, context);
    } catch (error) {
      console.error("[bot-nlu]", error);
    }
  }

  if (ai) {
    if (ai.intent !== "chat") return enrichAiIntent(ai, text, context);

    // AI bảo "chat" nhưng câu khớp mẫu lệnh rất rõ → vá lại bằng regex hẹp.
    if (isCancelConfirmation(text, context)) {
      return { intent: "cancel_session", names: [] };
    }
    // "đánh dấu đã trả", "tôi chuyển rồi" (không kèm số tiền = không phải ghi chi phí)
    if (
      /\b(danh dau|xac nhan)\b.*\b(tra|thanh toan|chuyen)\b/.test(t) ||
      (/\b(da tra|tra het|tra du|da chuyen( khoan)?|chuyen roi)\b/.test(t) && parseMoneyVn(text) === undefined)
    ) {
      return { intent: "mark_paid", names: [], session: parseSessionReference(text, context) };
    }
    if (isStrongAddLike(t)) {
      return { intent: "add_member", names: normalizeAddNames(text), session: parseSessionReference(text, context) };
    }
    if (isStrongCreateLike(t)) {
      return { intent: "create_session", names: parseCreateParticipants(text), session: parseCreateSessionDraft(text) };
    }
    const byRegex = detectIntentByRegex(text);
    if (byRegex) {
      return {
        intent: byRegex,
        names: [],
        session:
          byRegex === "list_attendees" || byRegex === "costs"
            ? parseSessionReference(text, context)
            : { date: parseCreateDate(text) }, // "buổi ngày mai" — chỉ lấy ngày nói rõ trong câu
      };
    }
    return { intent: "chat", names: [] };
  }

  // Không gọi được AI (thiếu key / lỗi mạng) → pipeline regex như trước.
  // Câu có số tiền + từ chi tiêu mà không phải câu hỏi → ghi chi phí.
  if (parseMoneyVn(text) !== undefined && /\b(tien|phi|san|nuoc|cau|bill)\b/.test(t) && !asksForCosts(t)) {
    return { intent: "add_cost", names: [], cost: { amount: parseMoneyVn(text) }, session: parseSessionReference(text, context) };
  }
  if (isCreateSessionLike(t)) {
    return { intent: "create_session", names: parseCreateParticipants(text), session: parseCreateSessionDraft(text) };
  }
  if (isAddLike(t)) {
    return { intent: "add_member", names: normalizeAddNames(text), session: parseSessionReference(text, context) };
  }
  const byRegex = detectIntentByRegex(text);
  if (byRegex) {
    return {
      intent: byRegex,
      names: [],
      session:
        byRegex === "list_attendees" || byRegex === "costs"
          ? parseSessionReference(text, context)
          : { date: parseCreateDate(text) },
    };
  }

  const cleaned = text.replace(/^\/(play|buoi)\b/i, "").trim();
  if (!cleaned) return { intent: "upcoming", names: [] };

  return { intent: "chat", names: [] };
}

// --- Truy vấn buổi chơi ---

type QueryOpts = {
  date?: string;
  from?: string;
  to?: string;
  venue?: string;
  onlyUpcoming?: boolean;
  excludeCompleted?: boolean;
  recent?: boolean;
  limit?: number;
};

type CostSummaryRow = {
  id: string;
  label: string;
  amount: number;
  quantity?: number | null;
  type?: string | null;
  payer_id?: string | null;
  payer_name?: string | null;
  consumer_id?: string | null;
  consumer_ids?: string | null;
  consumer_pending?: number | null;
};

type PaymentSummaryRow = {
  id: string;
  debtor_name?: string | null;
  recipient_name?: string | null;
  amount_owed: number;
  paid?: number | null;
  payer_marked_paid?: number | null;
};

async function querySessions(env: Env, groupId: string, opts: QueryOpts): Promise<SessionRow[]> {
  const where = ["s.group_id = ?"];
  const binds: unknown[] = [groupId];
  if (opts.date) {
    where.push("s.date = ?");
    binds.push(opts.date);
  }
  if (opts.from) {
    where.push("s.date >= ?");
    binds.push(opts.from);
  }
  if (opts.to) {
    where.push("s.date <= ?");
    binds.push(opts.to);
  }
  if (opts.venue) {
    where.push("lower(s.venue) LIKE ?");
    binds.push(`%${opts.venue.toLowerCase()}%`);
  }
  if (opts.onlyUpcoming) {
    where.push("s.status = 'upcoming'");
  }
  if (opts.excludeCompleted) {
    where.push("s.status != 'completed'");
  }

  const order = opts.recent
    ? "ORDER BY s.date DESC, s.start_time DESC"
    : "ORDER BY s.date ASC, s.start_time ASC";
  const limit = Math.max(1, Math.floor(opts.limit ?? MAX_SESSIONS_IN_REPLY));

  const sql = `
    SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
    FROM sessions s
    WHERE ${where.join(" AND ")}
    ${order}
    LIMIT ${limit}
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all<SessionRow>();
  return result.results ?? [];
}

function normalizeName(value: string) {
  return removeDiacritics(value.toLowerCase()).replace(/\s+/g, " ").trim();
}

function colorForUser(userId: string) {
  const total = [...userId].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return MEMBER_COLORS[total % MEMBER_COLORS.length];
}

async function getOrCreateMemberForUser(
  env: Env,
  groupId: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  const user = await env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; name?: string | null; email: string }>();
  if (!user) return null;

  const displayName = user.name || user.email;
  const existing = await env.DB.prepare(
    `SELECT id, name, group_id
     FROM members
     WHERE user_id = ?
       AND (group_id = ? OR group_id IS NULL)
     ORDER BY CASE WHEN group_id = ? THEN 0 ELSE 1 END
     LIMIT 1`
  )
    .bind(userId, groupId, groupId)
    .first<{ id: string; name: string; group_id?: string | null }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE members
       SET name = ?, is_active = 1, group_id = COALESCE(group_id, ?)
       WHERE id = ?`
    )
      .bind(displayName, groupId, existing.id)
      .run();
    return { id: existing.id, name: displayName };
  }

  const memberId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)"
  )
    .bind(memberId, groupId, userId, displayName, colorForUser(userId), new Date().toISOString())
    .run();
  return { id: memberId, name: displayName };
}

async function soonestUpcoming(env: Env, groupId: string): Promise<SessionRow | null> {
  const rows = await querySessions(env, groupId, { onlyUpcoming: true, limit: 1 });
  return rows[0] ?? null;
}

function hasSessionSelector(selector?: SessionDraft): boolean {
  return Boolean(selector?.date || selector?.startTime || selector?.venue);
}

function wantsUpcomingSession(text: string): boolean {
  const t = normalizeName(text);
  return /\b(sap toi|sap dien ra|ke tiep|tiep theo|buoi toi|gan nhat|next|upcoming)\b/.test(t);
}

function normalizeConsumerIds(value: string | null | undefined, fallback?: string | null) {
  let rawIds: string[] = [];
  const trimmed = value?.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      rawIds = Array.isArray(parsed) ? parsed : [trimmed];
    } catch {
      rawIds = trimmed.split(/[,;\n]+/);
    }
  }
  if (rawIds.length === 0 && fallback) rawIds = [fallback];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of rawIds) {
    const id = String(item ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// --- Chống nhầm buổi trùng tên: selector khớp >1 buổi thì hỏi lại thay vì tự chọn ---

type SessionResolution = { session: SessionRow | null; choices?: SessionRow[] };

async function matchSessionsBySelector(
  env: Env,
  groupId: string,
  selector: SessionDraft,
  upcomingOnly: boolean,
  limit = 4
): Promise<SessionRow[]> {
  const where = ["s.group_id = ?"];
  const binds: unknown[] = [groupId];
  if (upcomingOnly) where.push("s.status = 'upcoming'");
  if (selector.date) {
    where.push("s.date = ?");
    binds.push(selector.date);
  }
  if (selector.startTime) {
    where.push("s.start_time = ?");
    binds.push(selector.startTime);
  }
  if (selector.venue) {
    where.push("lower(s.venue) LIKE ?");
    binds.push(`%${selector.venue.toLowerCase()}%`);
  }

  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN s.status = 'upcoming' THEN 0 ELSE 1 END, s.date ASC, s.start_time ASC
     LIMIT ${limit}`
  )
    .bind(...binds)
    .all<SessionRow>();
  return result.results ?? [];
}

async function resolveSessionForAction(
  env: Env,
  groupId: string,
  selector: SessionDraft | undefined,
  upcomingOnly: boolean
): Promise<SessionResolution> {
  if (!hasSessionSelector(selector)) {
    return { session: await soonestUpcoming(env, groupId) };
  }
  const rows = await matchSessionsBySelector(env, groupId, selector!, upcomingOnly);
  if (rows.length > 1) return { session: null, choices: rows };
  return { session: rows[0] ?? null };
}

function ambiguousSessionsReply(choices: SessionRow[]): BotReply {
  const list = choices.map((s) => `• ${sessionSummaryLine(s)}`).join("\n");
  return {
    ok: false,
    reply: `Có ${choices.length} buổi khớp với mô tả — bạn ghi rõ thêm ngày/giờ giúp mình:\n${list}`,
  };
}

async function findUpcomingSession(env: Env, groupId: string, selector?: SessionDraft): Promise<SessionRow | null> {
  if (!hasSessionSelector(selector)) return soonestUpcoming(env, groupId);

  const where = ["s.group_id = ?", "s.status = 'upcoming'"];
  const binds: unknown[] = [groupId];
  if (selector?.date) {
    where.push("s.date = ?");
    binds.push(selector.date);
  }
  if (selector?.startTime) {
    where.push("s.start_time = ?");
    binds.push(selector.startTime);
  }
  if (selector?.venue) {
    where.push("lower(s.venue) LIKE ?");
    binds.push(`%${selector.venue.toLowerCase()}%`);
  }

  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE ${where.join(" AND ")}
     ORDER BY s.date ASC, s.start_time ASC
     LIMIT 1`
  )
    .bind(...binds)
    .first<SessionRow>();

  return result ?? null;
}

async function findSessionForCosts(
  env: Env,
  groupId: string,
  text: string,
  selector?: SessionDraft
): Promise<SessionRow | null> {
  if (wantsUpcomingSession(text) && !hasSessionSelector(selector)) return soonestUpcoming(env, groupId);

  if (hasSessionSelector(selector)) {
    for (const sel of loosenSelector(selector!)) {
      const row = await querySessionRow(env, groupId, sel, "DESC");
      if (row) return row;
    }
    return null;
  }

  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE s.group_id = ?
     ORDER BY
       CASE
         WHEN EXISTS (SELECT 1 FROM costs c WHERE c.session_id = s.id)
           OR EXISTS (SELECT 1 FROM payments p WHERE p.session_id = s.id)
         THEN 0 ELSE 1
       END,
       s.date DESC,
       s.start_time DESC
     LIMIT 1`
  )
    .bind(groupId)
    .first<SessionRow>();

  return result ?? null;
}

// Một query khớp buổi theo selector (date/startTime/venue). dateDir=ASC ưu tiên
// buổi sớm nhất, DESC ưu tiên gần đây nhất.
async function querySessionRow(
  env: Env,
  groupId: string,
  selector: SessionDraft,
  dateDir: "ASC" | "DESC" = "ASC"
): Promise<SessionRow | null> {
  const where = ["s.group_id = ?"];
  const binds: unknown[] = [groupId];
  if (selector.date) {
    where.push("s.date = ?");
    binds.push(selector.date);
  }
  if (selector.startTime) {
    where.push("s.start_time = ?");
    binds.push(selector.startTime);
  }
  if (selector.venue) {
    where.push("lower(s.venue) LIKE ?");
    binds.push(`%${selector.venue.toLowerCase()}%`);
  }
  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN s.status = 'upcoming' THEN 0 ELSE 1 END, s.date ${dateDir}, s.start_time ${dateDir}
     LIMIT 1`
  )
    .bind(...binds)
    .first<SessionRow>();
  return result ?? null;
}

// Nới lỏng selector dần để tránh "ràng buộc quá chặt": NLU đôi khi nhét thêm giờ
// (vd từ "hiện tại"/"bây giờ") hoặc sân thừa làm trượt khớp dù NGÀY vẫn đúng.
// Thứ tự tin cậy: ngày > sân > giờ. Bỏ giờ trước, rồi bỏ sân, giữ ngày làm mỏ neo.
function* loosenSelector(selector: SessionDraft): Generator<SessionDraft> {
  const variants: SessionDraft[] = [
    selector,
    { date: selector.date, venue: selector.venue },
    { date: selector.date },
    { venue: selector.venue },
  ];
  const seen = new Set<string>();
  for (const v of variants) {
    const clean: SessionDraft = {};
    if (v.date) clean.date = v.date;
    if (v.startTime) clean.startTime = v.startTime;
    if (v.venue) clean.venue = v.venue;
    if (!hasSessionSelector(clean)) continue;
    const key = JSON.stringify(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    yield clean;
  }
}

async function findSessionForAttendees(env: Env, groupId: string, selector?: SessionDraft): Promise<SessionRow | null> {
  if (!hasSessionSelector(selector)) return soonestUpcoming(env, groupId);
  for (const sel of loosenSelector(selector!)) {
    const row = await querySessionRow(env, groupId, sel, "ASC");
    if (row) return row;
  }
  return null;
}

async function handleQuery(
  env: Env,
  threadId: string,
  text: string,
  actor?: BotActor,
  context?: BotContextMessage[]
): Promise<BotReply> {
  const link = await env.DB.prepare("SELECT group_id FROM bot_thread_links WHERE thread_id = ?")
    .bind(threadId)
    .first<{ group_id: string }>();

  if (!link) {
    return {
      ok: true,
      reply:
        "Nhóm chat này chưa được liên kết với nhóm nào trên TingTing.\n" +
        "Admin hãy mở TingTing → nhóm → Liên kết Messenger để lấy mã, rồi gõ /connect <mã> tại đây.",
    };
  }

  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?")
    .bind(link.group_id)
    .first<{ name: string }>();
  const groupName = group?.name ?? "nhóm";
  const groupId = link.group_id;

  // Alias /alias của thread: resolve "tôi" và tên Messenger về đúng thành viên web.
  const aliases = await loadThreadAliases(env, threadId);
  if (actor?.name && !actor.memberId) {
    actor = { ...actor, memberId: aliases.get(normalizeName(actor.name)) };
  }

  const parsed = await resolveIntent(env, text, actor, context);

  switch (parsed.intent) {
    case "help":
      return { ok: true, reply: helpText() };
    case "list_members":
      return replyMembers(env, groupId, groupName);
    case "list_attendees":
      return replyAttendees(env, groupId, groupName, parsed.session);
    case "add_member":
      return replyAddMembers(env, groupId, groupName, parsed.names, actor, parsed.session, aliases);
    case "remove_member":
      return replyRemoveMembers(env, groupId, groupName, parsed.names, actor, parsed.session, aliases);
    case "create_session":
      return replyCreateSession(env, groupId, groupName, parsed.session, actor, parsed.names, aliases);
    case "update_session":
      return replyUpdateSession(env, groupId, groupName, parsed.session, parsed.changes);
    case "cancel_session":
      return replyCancelSession(env, groupId, groupName, text, parsed.session, context);
    case "stats":
      return replyStats(env, groupId, groupName, text);
    case "costs":
      return replyCosts(env, groupId, groupName, text, parsed.session);
    case "add_cost":
      return replyAddCost(env, groupId, groupName, text, actor, parsed.cost, parsed.session, aliases);
    case "mark_paid":
      return replyMarkPaid(env, groupId, groupName, text, parsed.session);
    case "chat":
      return replyNaturalChat(env, groupName, text, actor, context);
    default:
      return replySessions(env, groupId, groupName, parsed.intent, parsed.session);
  }
}

export async function handleGroupBotQuery(
  env: Env,
  groupId: string,
  text: string,
  actor?: BotActor,
  context?: BotContextMessage[]
): Promise<BotReply> {
  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?")
    .bind(groupId)
    .first<{ name: string }>();
  const groupName = group?.name ?? "nhom";

  const parsed = await resolveIntent(env, text, actor, context);

  switch (parsed.intent) {
    case "help":
      return { ok: true, reply: helpText() };
    case "list_members":
      return replyMembers(env, groupId, groupName);
    case "list_attendees":
      return replyAttendees(env, groupId, groupName, parsed.session);
    case "add_member":
      return replyAddMembers(env, groupId, groupName, parsed.names, actor, parsed.session);
    case "remove_member":
      return replyRemoveMembers(env, groupId, groupName, parsed.names, actor, parsed.session);
    case "create_session":
      return replyCreateSession(env, groupId, groupName, parsed.session, actor, parsed.names);
    case "update_session":
      return replyUpdateSession(env, groupId, groupName, parsed.session, parsed.changes);
    case "cancel_session":
      return replyCancelSession(env, groupId, groupName, text, parsed.session, context);
    case "stats":
      return replyStats(env, groupId, groupName, text);
    case "costs":
      return replyCosts(env, groupId, groupName, text, parsed.session);
    case "add_cost":
      return replyAddCost(env, groupId, groupName, text, actor, parsed.cost, parsed.session);
    case "mark_paid":
      return replyMarkPaid(env, groupId, groupName, text, parsed.session);
    case "chat":
      return replyNaturalChat(env, groupName, text, actor, context);
    default:
      return replySessions(env, groupId, groupName, parsed.intent, parsed.session);
  }
}

async function replySessions(
  env: Env,
  groupId: string,
  groupName: string,
  intent: Intent,
  selector?: SessionDraft
): Promise<BotReply> {
  const today = vnToday();
  let rows: SessionRow[];
  let header: string;

  // "/play ngày mai", "/play ở thủ đức" — có bộ lọc cụ thể thì ưu tiên nó.
  if (selector?.date || selector?.venue) {
    rows = await querySessions(env, groupId, {
      date: selector.date,
      venue: selector.venue,
      excludeCompleted: true,
    });
    const parts: string[] = [];
    if (selector.date) parts.push(`ngày ${formatDate(selector.date)}`);
    if (selector.venue) parts.push(`tại ${selector.venue}`);
    header = `📅 Buổi ${parts.join(" ")} của ${groupName}`;
    if (rows.length === 0) return { ok: true, reply: `${header}\nKhông có buổi nào.` };
    const blocks = await Promise.all(rows.map((row) => formatSessionDetailed(env, row)));
    return { ok: true, reply: `${header}\n\n${blocks.join("\n\n")}` };
  }

  if (intent === "today") {
    rows = await querySessions(env, groupId, { date: today });
    header = `📅 Buổi hôm nay (${formatDate(today)}) của ${groupName}`;
  } else if (intent === "week") {
    const week = vnWeekRange();
    rows = await querySessions(env, groupId, { from: week.from, to: week.to });
    header = `📅 Buổi tuần này của ${groupName}`;
  } else if (intent === "recent") {
    // Chỉ buổi còn "sống": chưa hoàn thành và trong vòng 15 ngày đổ lại.
    rows = await querySessions(env, groupId, { recent: true, from: vnDateAfter(-15), excludeCompleted: true });
    header = `📅 Các buổi gần đây của ${groupName} (15 ngày, chưa xong)`;
  } else if (intent === "next") {
    // Lọc cả date >= hôm nay: buổi quá hạn chưa hoàn thành không phải "kế tiếp".
    rows = await querySessions(env, groupId, { onlyUpcoming: true, from: today, limit: 1 });
    header = `📅 Buổi kế tiếp của ${groupName}`;
  } else {
    rows = await querySessions(env, groupId, { onlyUpcoming: true, from: today });
    header = `📅 Buổi sắp tới của ${groupName}`;
  }

  if (rows.length === 0) {
    const none = intent === "recent" ? "Chưa có buổi nào." : "Chưa có buổi nào sắp tới.";
    return { ok: true, reply: `${header}\n${none}` };
  }

  const blocks = await Promise.all(rows.map((row) => formatSessionDetailed(env, row)));
  return { ok: true, reply: `${header}\n\n${blocks.join("\n\n")}` };
}

async function replyMembers(env: Env, groupId: string, groupName: string): Promise<BotReply> {
  const result = await env.DB
    .prepare("SELECT name FROM members WHERE group_id = ? AND is_active = 1 AND is_walkin = 0 ORDER BY name COLLATE NOCASE")
    .bind(groupId)
    .all<{ name: string }>();
  const members = result.results ?? [];
  if (!members.length) return { ok: true, reply: `Nhóm ${groupName} chưa có thành viên nào.` };
  const list = members.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
  return { ok: true, reply: `👥 Thành viên nhóm ${groupName} (${members.length}):\n${list}` };
}

async function replyAttendees(
  env: Env,
  groupId: string,
  groupName: string,
  selector?: SessionDraft
): Promise<BotReply> {
  const session = await findSessionForAttendees(env, groupId, selector);
  if (!session) {
    const suffix = hasSessionSelector(selector) ? "phù hợp" : "sắp tới";
    return { ok: true, reply: `${groupName}: chưa có buổi ${suffix} nào.` };
  }

  const result = await env.DB
    .prepare(
      `SELECT m.name FROM session_members sm
       JOIN members m ON m.id = sm.member_id
       WHERE sm.session_id = ? AND sm.attended = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .bind(session.id)
    .all<{ name: string }>();
  const names = result.results ?? [];
  const lines = [`🏸 ${sessionSummaryLine(session)}`];
  if (session.venue && session.venue !== sessionTitle(session)) lines.push(`Sân: ${session.venue}`);
  if (session.location) lines.push(`📍 ${session.location}`);
  if (session.note) lines.push(`📝 ${session.note}`);
  if (!names.length) return { ok: true, reply: `${lines.join("\n")}\nChưa có ai tham gia.` };
  const list = names.map((n) => `• ${n.name}`).join("\n");
  return { ok: true, reply: `${lines.join("\n")}\n👥 ${names.length} người tham gia:\n${list}` };
}

function formatCostScope(cost: CostSummaryRow, memberNames: Map<string, string>) {
  if (cost.consumer_pending) return "chờ chọn người dùng";
  const consumerIds = normalizeConsumerIds(cost.consumer_ids, cost.consumer_id);
  if (!consumerIds.length) return "chia đều";
  const names = consumerIds.map((id) => memberNames.get(id) || "người dùng").join(", ");
  return `dùng: ${names}`;
}

function formatCostLine(cost: CostSummaryRow, memberNames: Map<string, string>) {
  const label = cost.label?.trim() || "Chi phí";
  const qty = Number(cost.quantity ?? 1);
  const quantity = Number.isFinite(qty) && qty > 1 ? ` x${qty}` : "";
  const payer = cost.payer_name?.trim() || (cost.payer_id ? memberNames.get(cost.payer_id) : "") || "người nhận chung/quỹ";
  return `• ${label}${quantity}: ${formatMoney(cost.amount)} (${payer} trả; ${formatCostScope(cost, memberNames)})`;
}

function formatPaymentStatus(payment: PaymentSummaryRow) {
  if (payment.paid) return "đã nhận";
  if (payment.payer_marked_paid) return "đã báo chuyển";
  return "chưa trả";
}

async function replyCosts(
  env: Env,
  groupId: string,
  groupName: string,
  text: string,
  selector?: SessionDraft
): Promise<BotReply> {
  const session = await findSessionForCosts(env, groupId, text, selector);
  if (!session) return { ok: true, reply: `${groupName}: chưa tìm thấy buổi để xem chi phí.` };

  const [costRows, paymentRows, memberRows] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.label, c.amount, c.quantity, c.type, c.payer_id, c.consumer_id, c.consumer_ids, c.consumer_pending,
        payer.name AS payer_name
       FROM costs c
       LEFT JOIN members payer ON payer.id = c.payer_id
       WHERE c.session_id = ?
       ORDER BY c.rowid ASC`
    )
      .bind(session.id)
      .all<CostSummaryRow>(),
    env.DB.prepare(
      `SELECT p.id, p.amount_owed, p.paid, p.payer_marked_paid,
        debtor.name AS debtor_name,
        recipient.name AS recipient_name
       FROM payments p
       JOIN members debtor ON debtor.id = p.member_id
       LEFT JOIN members recipient ON recipient.id = p.recipient_member_id
       WHERE p.session_id = ? AND p.amount_owed > 0
       ORDER BY p.paid ASC, debtor.name COLLATE NOCASE, recipient.name COLLATE NOCASE`
    )
      .bind(session.id)
      .all<PaymentSummaryRow>(),
    env.DB.prepare("SELECT id, name FROM members WHERE group_id = ?")
      .bind(groupId)
      .all<{ id: string; name: string }>(),
  ]);

  const costs = costRows.results ?? [];
  const payments = paymentRows.results ?? [];
  const memberNames = new Map((memberRows.results ?? []).map((m) => [m.id, m.name]));
  const total = costs.reduce((sum, item) => sum + Math.round(Number(item.amount) || 0), 0);
  const pendingTotal = costs
    .filter((item) => item.consumer_pending)
    .reduce((sum, item) => sum + Math.round(Number(item.amount) || 0), 0);

  const lines = [`💸 Chi phí buổi ${sessionSummaryLine(session)}`];
  lines.push(`Tổng đã nhập: ${formatMoney(total)}`);
  if (pendingTotal > 0) lines.push(`Đang chờ gán người dùng: ${formatMoney(pendingTotal)}`);

  if (!costs.length) {
    lines.push("Chưa có khoản chi nào được nhập.");
  } else {
    const visibleCosts = costs.slice(0, 8).map((cost) => formatCostLine(cost, memberNames));
    lines.push("", "Các khoản:", ...visibleCosts);
    if (costs.length > visibleCosts.length) lines.push(`• ... còn ${costs.length - visibleCosts.length} khoản nữa`);
  }

  if (payments.length) {
    const visiblePayments = payments.slice(0, 10).map((payment) => {
      const debtor = payment.debtor_name?.trim() || "người trả";
      const recipient = payment.recipient_name?.trim() || "người nhận";
      return `• ${debtor} → ${recipient}: ${formatMoney(payment.amount_owed)} (${formatPaymentStatus(payment)})`;
    });
    lines.push("", "Cần chuyển:", ...visiblePayments);
    if (payments.length > visiblePayments.length) lines.push(`• ... còn ${payments.length - visiblePayments.length} dòng nữa`);
  } else if (costs.length) {
    lines.push("", "Chưa thấy dòng công nợ cần chuyển. Nếu vừa sửa chi phí, bấm tính lại chia tiền trên web để cập nhật payments.");
  }

  return { ok: true, reply: lines.join("\n") };
}

// Xác nhận "đã trả tiền" là thao tác nhạy cảm (đúng người, đúng khoản, đúng chiều nợ)
// — bot KHÔNG tự làm, chỉ đưa link đến trang buổi trên web.
async function replyMarkPaid(
  env: Env,
  groupId: string,
  groupName: string,
  text: string,
  selector?: SessionDraft
): Promise<BotReply> {
  const session = await findSessionForCosts(env, groupId, text, selector);
  if (!session) {
    return { ok: true, reply: `${groupName}: chưa tìm thấy buổi nào có công nợ để xác nhận.` };
  }
  const base = (env.FRONTEND_URL || "https://caulong.hunn.io.vn").replace(/\/+$/, "");
  return {
    ok: true,
    reply: [
      `🔒 Xác nhận "đã trả" cần làm trên web để chắc đúng người, đúng khoản:`,
      `🏸 ${sessionSummaryLine(session)}`,
      `👉 ${base}/sessions/${session.id}`,
      'Xem nhanh công nợ tại đây thì gõ "ai nợ ai".',
    ].join("\n"),
  };
}

// Buổi mặc định để ghi chi phí: hôm nay → gần nhất đã qua → sắp tới gần nhất.
async function findSessionForAddCost(env: Env, groupId: string, selector?: SessionDraft): Promise<SessionRow | null> {
  if (hasSessionSelector(selector)) return findSessionForAttendees(env, groupId, selector);

  const recent = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE s.group_id = ? AND s.date <= ?
     ORDER BY s.date DESC, s.start_time DESC
     LIMIT 1`
  )
    .bind(groupId, vnToday())
    .first<SessionRow>();
  return recent ?? soonestUpcoming(env, groupId);
}

function matchMembersByName(
  members: Array<{ id: string; name: string }>,
  raw: string,
  aliases?: Map<string, string>
): Array<{ id: string; name: string }> {
  const q = normalizeName(raw);
  if (!q) return [];
  let matches = members.filter((m) => normalizeName(m.name) === q);
  if (!matches.length) matches = members.filter((m) => normalizeName(m.name).includes(q));
  if (!matches.length && aliases?.has(q)) {
    const aliased = members.find((m) => m.id === aliases.get(q));
    if (aliased) matches = [aliased];
  }
  return matches;
}

function resolveMemberByName(
  members: Array<{ id: string; name: string }>,
  raw: string,
  aliases?: Map<string, string>
): { id: string; name: string } | null {
  const matches = matchMembersByName(members, raw, aliases);
  return matches.length === 1 ? matches[0] : null;
}

function resolveSelfMember(
  members: Array<{ id: string; name: string }>,
  actor?: BotActor
): { id: string; name: string } | null {
  if (actor?.memberId) {
    const m = members.find((x) => x.id === actor.memberId);
    if (m) return m;
  }
  if (actor?.name) return resolveMemberByName(members, actor.name);
  return null;
}

async function replyAddCost(
  env: Env,
  groupId: string,
  groupName: string,
  text: string,
  actor?: BotActor,
  cost?: CostDraft,
  selector?: SessionDraft,
  aliases?: Map<string, string>
): Promise<BotReply> {
  const amount = cost?.amount ?? parseMoneyVn(text);
  if (!amount || amount < 1000) {
    return { ok: false, reply: 'Mình chưa rõ số tiền. Ví dụ: "tiền sân 240k" hoặc "3 ống cầu 270k Nam trả".' };
  }

  let session: SessionRow | null;
  if (hasSessionSelector(selector)) {
    const resolution = await resolveSessionForAction(env, groupId, selector, false);
    if (resolution.choices) return ambiguousSessionsReply(resolution.choices);
    session = resolution.session;
  } else {
    session = await findSessionForAddCost(env, groupId);
  }
  if (!session) return { ok: true, reply: `${groupName}: chưa có buổi nào để ghi chi phí.` };

  if (await sessionHasPaidTransfer(env, session.id)) return { ok: false, reply: PAID_LOCK_REPLY };

  const members =
    (await env.DB.prepare("SELECT id, name FROM members WHERE group_id = ? AND is_active = 1 AND is_walkin = 0")
      .bind(groupId)
      .all<{ id: string; name: string }>()).results ?? [];

  // Người trả: nhắc tên → match; "tôi trả" → alias người gửi; không nói gì → coi như người gửi ứng.
  let payer: { id: string; name: string } | null = null;
  if (cost?.payerName && cost.payerName !== SELF_NAME_TOKEN && !isSelfReference(cost.payerName)) {
    payer = resolveMemberByName(members, cost.payerName, aliases);
  } else {
    payer = resolveSelfMember(members, actor);
  }

  // Phạm vi chia: người dùng liệt kê người hưởng ("cho A, B, C") → chỉ chia cho họ;
  // không liệt kê ai → để trống = chia đều cả buổi.
  const consumerIds: string[] = [];
  const unresolvedConsumers: string[] = [];
  for (const name of cost?.consumerNames ?? []) {
    const m = resolveMemberByName(members, name, aliases);
    if (m) {
      if (!consumerIds.includes(m.id)) consumerIds.push(m.id);
    } else {
      unresolvedConsumers.push(name);
    }
  }
  const consumerNamesResolved = consumerIds
    .map((id) => members.find((mem) => mem.id === id)?.name)
    .filter((n): n is string => !!n);

  const label = cost?.label?.trim() || "Chi phí";
  const quantity = cost?.quantity && cost.quantity >= 1 ? Math.floor(cost.quantity) : 1;
  const costId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO costs (id, session_id, label, amount, quantity, type, payer_id, consumer_id, consumer_ids, consumer_pending)
     VALUES (?, ?, ?, ?, ?, 'other', ?, ?, ?, 0)`
  )
    .bind(
      costId,
      session.id,
      label,
      Math.round(amount),
      quantity,
      payer?.id ?? null,
      consumerIds[0] ?? null,
      consumerIds.length ? JSON.stringify(consumerIds) : null
    )
    .run();

  const recalcError = await recalcSessionPayments(env, session.id);
  const totalRow = await env.DB.prepare("SELECT SUM(amount) AS total FROM costs WHERE session_id = ?")
    .bind(session.id)
    .first<{ total: number | null }>();

  // Echo đầy đủ — tiền bạc phải nhìn thấy được mình vừa ghi gì.
  const scope = consumerNamesResolved.length ? `chia cho ${consumerNamesResolved.join(", ")}` : "chia đều";
  const lines = [
    `🧾 Đã ghi vào buổi ${sessionSummaryLine(session)}:`,
    `• ${label}${quantity > 1 ? ` x${quantity}` : ""}: ${formatMoney(amount)} (${payer ? `${payer.name} trả` : "chưa rõ ai trả"}, ${scope})`,
    `Tổng buổi này: ${formatMoney(Number(totalRow?.total) || 0)}`,
  ];
  if (!payer) {
    lines.push('⚠️ Chưa xác định được người trả — gán lại trên web, hoặc /alias rồi nhắn kiểu "tiền sân 240k tôi trả".');
  }
  if (unresolvedConsumers.length) {
    lines.push(
      `⚠️ Không khớp được người chia: ${unresolvedConsumers.join(", ")} — kiểm tra lại tên/alias, hoặc gán trên web.`
    );
  }
  if (recalcError) {
    lines.push(`⚠️ Chưa chia lại được tiền (${recalcError}) — kiểm tra trên web nhé.`);
  } else {
    lines.push('Gõ "ai nợ ai" để xem công nợ mới. Sai thì sửa trên web.');
  }
  return { ok: true, reply: lines.join("\n") };
}

async function replyCreateSession(
  env: Env,
  groupId: string,
  groupName: string,
  draft?: SessionDraft,
  actor?: BotActor,
  names: string[] = [],
  aliases?: Map<string, string>
): Promise<BotReply> {
  const missing: string[] = [];
  if (!draft?.date) missing.push("ngày");
  if (!draft?.startTime) missing.push("giờ");
  if (!draft?.venue) missing.push("địa điểm/sân");

  if (missing.length) {
    return {
      ok: false,
      reply:
        `Mình tạo kèo được, nhưng còn thiếu ${missing.join(", ")}.\n` +
        'Ví dụ: "set kèo mới ngày mai ở Thủ Đức lúc 17:00".',
    };
  }

  const sessionDate = draft!.date!;
  const startTime = draft!.startTime!;
  const venue = draft!.venue!;

  const existing = await env.DB.prepare(
    `SELECT s.id, s.name, s.date, s.start_time, s.end_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE s.group_id = ? AND s.date = ? AND s.start_time = ? AND lower(s.venue) = lower(?) AND s.status = 'upcoming'
     LIMIT 1`
  )
    .bind(groupId, sessionDate, startTime, venue)
    .first<SessionRow>();

  if (existing) {
    if (names.length) {
      const outcome = await addNamesToSession(env, groupId, existing.id, names, actor, aliases);
      return { ok: true, reply: `Kèo này đã có rồi nè:\n${formatSession(existing)}${formatAddOutcome(outcome)}` };
    }
    return { ok: true, reply: `Kèo này đã có rồi nè:\n${formatSession(existing)}` };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, group_id, created_by, date, start_time, venue, location, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'upcoming', ?)`
  )
    .bind(id, groupId, actor?.userId ?? null, sessionDate, startTime, venue, draft?.note ?? null, now)
    .run();

  const session: SessionRow = {
    id,
    date: sessionDate,
    start_time: startTime,
    venue,
    location: null,
    note: draft?.note ?? null,
    status: "upcoming",
    attendee_count: 0,
  };

  // "tạo kèo ... gồm có tôi và A" — thêm luôn người được nhắc trong câu.
  let outcomeText = "";
  if (names.length) {
    const outcome = await addNamesToSession(env, groupId, id, names, actor, aliases);
    session.attendee_count = outcome.added.length;
    outcomeText = formatAddOutcome(outcome);
  }

  return {
    ok: true,
    reply: `✅ Đã tạo kèo mới cho ${groupName}:\n${formatSession(session)}${outcomeText}\nAi đi thì nhắn "thêm tôi vào buổi" nhé.`,
  };
}

type AddOutcome = { added: string[]; already: string[]; ambiguous: string[]; notFound: string[] };

function formatAddOutcome(outcome: AddOutcome): string {
  const lines: string[] = [];
  if (outcome.added.length) lines.push(`✅ Đã thêm: ${outcome.added.join(", ")}`);
  if (outcome.already.length) lines.push(`ℹ️ Đã có sẵn: ${outcome.already.join(", ")}`);
  if (outcome.ambiguous.length) lines.push(`⚠️ Trùng tên, ghi rõ hơn: ${outcome.ambiguous.join(", ")}`);
  if (outcome.notFound.length) {
    lines.push(`❓ Không tìm thấy: ${outcome.notFound.join(", ")} (gõ "thành viên" xem danh sách, hoặc /alias <tên web> để ghép tên Messenger)`);
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

async function addNamesToSession(
  env: Env,
  groupId: string,
  sessionId: string,
  names: string[],
  actor?: BotActor,
  aliases?: Map<string, string>
): Promise<AddOutcome> {
  const selfMember =
    names.includes(SELF_NAME_TOKEN) && actor?.userId ? await getOrCreateMemberForUser(env, groupId, actor.userId) : null;

  const members =
    (await env.DB.prepare("SELECT id, name FROM members WHERE group_id = ? AND is_active = 1 AND is_walkin = 0")
      .bind(groupId)
      .all<{ id: string; name: string }>()).results ?? [];
  const attendingRows =
    (await env.DB.prepare("SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1")
      .bind(sessionId)
      .all<{ member_id: string }>()).results ?? [];
  const attending = new Set(attendingRows.map((r) => r.member_id));

  const added: string[] = [];
  const already: string[] = [];
  const ambiguous: string[] = [];
  const notFound: string[] = [];
  const toInsert: string[] = [];

  const queueMember = (member: { id: string; name: string }) => {
    if (attending.has(member.id)) {
      already.push(member.name);
      return;
    }
    toInsert.push(member.id);
    added.push(member.name);
    attending.add(member.id);
  };

  for (const raw of names) {
    if (raw === SELF_NAME_TOKEN) {
      if (selfMember) {
        queueMember(selfMember);
        continue;
      }
      // Người gửi đã /alias — đáng tin hơn match theo tên hiển thị.
      if (actor?.memberId) {
        const aliased = members.find((m) => m.id === actor.memberId);
        if (aliased) {
          queueMember(aliased);
          continue;
        }
      }
      if (actor?.name) {
        const actorName = normalizeName(actor.name);
        let matches = members.filter((m) => normalizeName(m.name) === actorName);
        if (matches.length === 0) matches = members.filter((m) => normalizeName(m.name).includes(actorName));
        if (matches.length === 1) {
          queueMember(matches[0]);
          continue;
        }
      }
      notFound.push("bạn");
      continue;
    }

    const q = normalizeName(raw);
    if (!q) continue;
    let matches = members.filter((m) => normalizeName(m.name) === q);
    if (matches.length === 0) matches = members.filter((m) => normalizeName(m.name).includes(q));
    if (matches.length === 0 && aliases?.has(q)) {
      // Tên gọi theo Messenger ("thêm Hunn") — tra alias của thread.
      const aliased = members.find((m) => m.id === aliases.get(q));
      if (aliased) matches = [aliased];
    }
    if (matches.length === 0) {
      notFound.push(raw);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(raw);
      continue;
    }
    queueMember(matches[0]);
  }

  if (toInsert.length) {
    const stmts = toInsert.map((memberId) =>
      env.DB.prepare("INSERT OR IGNORE INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
        .bind(sessionId, memberId)
    );
    // Xoá payment chưa trả để tính lại chia tiền (giống flow join/điểm danh của app).
    stmts.push(env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(sessionId));
    await env.DB.batch(stmts);
  }

  return { added, already, ambiguous, notFound };
}

async function replyAddMembers(
  env: Env,
  groupId: string,
  groupName: string,
  names: string[],
  actor?: BotActor,
  selector?: SessionDraft,
  aliases?: Map<string, string>
): Promise<BotReply> {
  if (!names.length) {
    return { ok: false, reply: 'Bạn muốn thêm ai? Ví dụ: "thêm An vào buổi".' };
  }

  const { session, choices } = await resolveSessionForAction(env, groupId, selector, true);
  if (choices) return ambiguousSessionsReply(choices);
  if (!session) {
    const hint = hasSessionSelector(selector) ? " phù hợp" : "";
    return { ok: true, reply: `${groupName}: chưa có buổi sắp tới${hint} để thêm người.` };
  }

  if (await sessionHasPaidTransfer(env, session.id)) return { ok: false, reply: PAID_LOCK_REPLY };

  const outcome = await addNamesToSession(env, groupId, session.id, names, actor, aliases);
  const header = `🏸 ${sessionSummaryLine(session)}`;
  return { ok: true, reply: `${header}${formatAddOutcome(outcome)}` };
}

async function replyRemoveMembers(
  env: Env,
  groupId: string,
  groupName: string,
  names: string[],
  actor?: BotActor,
  selector?: SessionDraft,
  aliases?: Map<string, string>
): Promise<BotReply> {
  if (!names.length) {
    return { ok: false, reply: 'Bạn muốn rút ai khỏi buổi? Ví dụ: "bớt tôi ra" hoặc "Nam không đi nữa".' };
  }

  const { session, choices } = await resolveSessionForAction(env, groupId, selector, true);
  if (choices) return ambiguousSessionsReply(choices);
  if (!session) {
    const hint = hasSessionSelector(selector) ? " phù hợp" : "";
    return { ok: true, reply: `${groupName}: chưa có buổi sắp tới${hint} để rút người.` };
  }

  if (await sessionHasPaidTransfer(env, session.id)) return { ok: false, reply: PAID_LOCK_REPLY };

  const members =
    (await env.DB.prepare("SELECT id, name FROM members WHERE group_id = ? AND is_active = 1 AND is_walkin = 0")
      .bind(groupId)
      .all<{ id: string; name: string }>()).results ?? [];
  const attendingRows =
    (await env.DB.prepare("SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1")
      .bind(session.id)
      .all<{ member_id: string }>()).results ?? [];
  const attending = new Set(attendingRows.map((r) => r.member_id));

  const removed: string[] = [];
  const notIn: string[] = [];
  const ambiguous: string[] = [];
  const notFound: string[] = [];
  const toDelete: string[] = [];

  const queueRemove = (member: { id: string; name: string }) => {
    if (!attending.has(member.id)) {
      notIn.push(member.name);
      return;
    }
    toDelete.push(member.id);
    removed.push(member.name);
    attending.delete(member.id);
  };

  for (const raw of names) {
    if (raw === SELF_NAME_TOKEN) {
      const self = resolveSelfMember(members, actor);
      if (self) queueRemove(self);
      else notFound.push("bạn (chưa /alias?)");
      continue;
    }
    const matches = matchMembersByName(members, raw, aliases);
    if (matches.length === 0) {
      notFound.push(raw);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(raw);
      continue;
    }
    queueRemove(matches[0]);
  }

  if (toDelete.length) {
    const stmts = toDelete.map((memberId) =>
      env.DB.prepare("DELETE FROM session_members WHERE session_id = ? AND member_id = ?").bind(session.id, memberId)
    );
    stmts.push(env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(session.id));
    await env.DB.batch(stmts);
    // Chia lại tiền với danh sách mới; buổi trống người thì thôi (payments chưa trả đã xoá).
    await recalcSessionPayments(env, session.id);
  }

  const lines = [`🏸 ${sessionSummaryLine(session)}`];
  if (session.venue && session.venue !== sessionTitle(session)) lines.push(`Sân: ${session.venue}`);
  if (removed.length) lines.push(`✅ Đã rút: ${removed.join(", ")}`);
  if (notIn.length) lines.push(`ℹ️ Vốn không có trong buổi: ${notIn.join(", ")}`);
  if (ambiguous.length) lines.push(`⚠️ Trùng tên, ghi rõ hơn: ${ambiguous.join(", ")}`);
  if (notFound.length) lines.push(`❓ Không tìm thấy: ${notFound.join(", ")}`);
  return { ok: true, reply: lines.join("\n") };
}

function parseStatsPeriod(text: string): { from: string; to: string; label: string } {
  const t = normalizeName(text);
  const now = vnNow();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (/\btuan nay\b|\btuan\b/.test(t) && !/\btuan truoc\b/.test(t)) {
    const week = vnWeekRange();
    return { ...week, label: "tuần này" };
  }
  if (/\bthang truoc\b/.test(t)) {
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { from, to, label: "tháng trước" };
  }
  if (/\bnam nay\b|\btrong nam\b|\bca nam\b/.test(t)) {
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: `năm ${year}` };
  }
  const from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from, to, label: "tháng này" };
}

async function replyStats(env: Env, groupId: string, groupName: string, text: string): Promise<BotReply> {
  const { from, to, label } = parseStatsPeriod(text);

  const [sessionRow, costRow, topRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE group_id = ? AND date BETWEEN ? AND ?")
      .bind(groupId, from, to)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT SUM(c.amount) AS total FROM costs c
       JOIN sessions s ON s.id = c.session_id
       WHERE s.group_id = ? AND s.date BETWEEN ? AND ?`
    )
      .bind(groupId, from, to)
      .first<{ total: number | null }>(),
    env.DB.prepare(
      `SELECT m.name, COUNT(*) AS n FROM session_members sm
       JOIN sessions s ON s.id = sm.session_id
       JOIN members m ON m.id = sm.member_id
       WHERE s.group_id = ? AND s.date BETWEEN ? AND ? AND sm.attended = 1
       GROUP BY m.id ORDER BY n DESC, m.name COLLATE NOCASE LIMIT 5`
    )
      .bind(groupId, from, to)
      .all<{ name: string; n: number }>(),
  ]);

  const sessionCount = Number(sessionRow?.n) || 0;
  const total = Number(costRow?.total) || 0;
  const top = topRows.results ?? [];

  const lines = [`📊 Thống kê ${label} của ${groupName} (${formatDate(from)} → ${formatDate(to)})`];
  lines.push(`🏸 Số buổi: ${sessionCount}`);
  lines.push(`💸 Tổng chi: ${formatMoney(total)}`);
  if (top.length) {
    lines.push("🔥 Chăm đi nhất:");
    top.forEach((row, i) => lines.push(`${i + 1}. ${row.name} — ${row.n} buổi`));
  }
  if (!sessionCount) lines.push("Chưa có buổi nào trong khoảng này.");
  return { ok: true, reply: lines.join("\n") };
}

async function replyUpdateSession(
  env: Env,
  groupId: string,
  groupName: string,
  selector?: SessionDraft,
  changes?: SessionDraft
): Promise<BotReply> {
  if (!changes || (!changes.date && !changes.startTime && !changes.venue)) {
    return { ok: false, reply: 'Bạn muốn đổi gì? Ví dụ: "dời kèo mai sang 19h" hoặc "đổi sân sang Q7".' };
  }

  const { session, choices } = await resolveSessionForAction(env, groupId, selector, true);
  if (choices) return ambiguousSessionsReply(choices);
  if (!session) {
    return { ok: true, reply: `${groupName}: chưa có buổi sắp tới phù hợp để sửa.` };
  }

  if (await sessionHasPaidTransfer(env, session.id)) return { ok: false, reply: PAID_LOCK_REPLY };

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (changes.date) {
    sets.push("date = ?");
    binds.push(changes.date);
  }
  if (changes.startTime) {
    sets.push("start_time = ?");
    binds.push(changes.startTime);
  }
  if (changes.venue) {
    sets.push("venue = ?");
    binds.push(changes.venue);
  }
  binds.push(session.id);
  await env.DB.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  const updated: SessionRow = {
    ...session,
    date: changes.date ?? session.date,
    start_time: changes.startTime ?? session.start_time,
    venue: changes.venue ?? session.venue,
  };
  return {
    ok: true,
    reply: `✏️ Đã sửa kèo:\n${sessionSummaryLine(session)}\n→ ${sessionSummaryLine(updated)}`,
  };
}

// Bot Messenger chỉ forward tin bắt đầu bằng "/" (hoặc nhắc tên) — nên hướng dẫn
// kèm "/" và khi so khớp phải bỏ "/" + tên bot ở đầu câu.
const CANCEL_CONFIRM_HINT = 'Trả lời "/đồng ý hủy" để xác nhận';

function isCancelConfirmation(text: string, context?: BotContextMessage[]): boolean {
  const t = normalizeName(text.replace(/^[/\s]+/, ""));
  const saidYes = /^(dong y( huy)?( keo)?|ok(e|ay)?( huy)?|xac nhan( huy)?|chac chan( huy)?|huy di)$/.test(t);
  if (!saidYes) return false;
  const lastAssistant = [...(context ?? [])].reverse().find((m) => m.role === "assistant");
  return Boolean(lastAssistant?.text.includes("đồng ý hủy"));
}

async function replyCancelSession(
  env: Env,
  groupId: string,
  groupName: string,
  text: string,
  selector?: SessionDraft,
  context?: BotContextMessage[]
): Promise<BotReply> {
  const confirmed = isCancelConfirmation(text, context);
  // Câu xác nhận ngắn không chứa thông tin buổi — lấy lại từ chính câu hỏi của bot trong context.
  const effectiveSelector = confirmed ? parseContextSessionReference(context) : selector;

  const { session, choices } = await resolveSessionForAction(env, groupId, effectiveSelector, true);
  if (choices) return ambiguousSessionsReply(choices);
  if (!session) {
    return { ok: true, reply: `${groupName}: không thấy buổi sắp tới phù hợp để hủy.` };
  }

  if (!confirmed) {
    return {
      ok: true,
      reply: `❓ Xác nhận hủy kèo này?\n🏸 ${sessionSummaryLine(session)} (${session.attendee_count} người)\n${CANCEL_CONFIRM_HINT}.`,
    };
  }

  const paidRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE session_id = ? AND paid = 1"
  )
    .bind(session.id)
    .first<{ n: number }>();
  if (Number(paidRow?.n) > 0) {
    return { ok: false, reply: "Buổi này đã có thanh toán được xác nhận — muốn hủy thì thao tác trên web nhé." };
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(session.id),
    env.DB.prepare("DELETE FROM costs WHERE session_id = ?").bind(session.id),
    env.DB.prepare("DELETE FROM session_members WHERE session_id = ?").bind(session.id),
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id),
  ]);

  return {
    ok: true,
    reply: `🗑️ Đã hủy kèo ${sessionSummaryLine(session)}.`,
  };
}

// --- Alias: ghép tên Messenger ↔ thành viên web ---

async function loadThreadAliases(env: Env, threadId: string): Promise<Map<string, string>> {
  const rows =
    (await env.DB.prepare("SELECT sender_norm, member_id FROM bot_sender_aliases WHERE thread_id = ?")
      .bind(threadId)
      .all<{ sender_norm: string; member_id: string }>()).results ?? [];
  return new Map(rows.map((r) => [r.sender_norm, r.member_id]));
}

async function handleAlias(env: Env, threadId: string, senderName: string | null, text: string): Promise<BotReply> {
  const link = await env.DB.prepare("SELECT group_id FROM bot_thread_links WHERE thread_id = ?")
    .bind(threadId)
    .first<{ group_id: string }>();
  if (!link) {
    return { ok: false, reply: "Nhóm chat này chưa liên kết với nhóm nào trên TingTing. Gõ /connect <mã> trước đã nhé." };
  }
  if (!senderName) {
    return { ok: false, reply: "Mình không đọc được tên người gửi của tin này, bạn gửi lại lệnh giúp mình nhé." };
  }

  const arg = text.replace(/^\/alias/i, "").trim();
  const senderNorm = normalizeName(senderName);

  if (!arg) {
    const row = await env.DB.prepare(
      `SELECT m.name FROM bot_sender_aliases a
       JOIN members m ON m.id = a.member_id
       WHERE a.thread_id = ? AND a.sender_norm = ?`
    )
      .bind(threadId, senderNorm)
      .first<{ name: string }>();
    if (!row) {
      return {
        ok: true,
        reply: `"${senderName}" chưa ghép với thành viên nào trên web.\nGõ /alias <tên trên web> để ghép, ví dụ: /alias Mặt Trời Nhỏ.`,
      };
    }
    return { ok: true, reply: `"${senderName}" đang ghép với «${row.name}». Gõ /alias xoa để bỏ ghép.` };
  }

  if (/^(xoa|huy|bo|off|remove|delete)$/.test(normalizeName(arg))) {
    const result = await env.DB.prepare("DELETE FROM bot_sender_aliases WHERE thread_id = ? AND sender_norm = ?")
      .bind(threadId, senderNorm)
      .run();
    return {
      ok: true,
      reply: result.meta?.changes ? `Đã bỏ ghép alias của "${senderName}".` : `"${senderName}" chưa có alias nào để xoá.`,
    };
  }

  const members =
    (await env.DB.prepare("SELECT id, name FROM members WHERE group_id = ? AND is_active = 1 AND is_walkin = 0")
      .bind(link.group_id)
      .all<{ id: string; name: string }>()).results ?? [];
  const q = normalizeName(arg);
  let matches = members.filter((m) => normalizeName(m.name) === q);
  if (!matches.length) matches = members.filter((m) => normalizeName(m.name).includes(q));
  if (!matches.length) {
    return { ok: false, reply: `Không tìm thấy thành viên "${arg}" trên web. Gõ "thành viên" để xem danh sách tên.` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reply: `Có ${matches.length} thành viên khớp "${arg}": ${matches.map((m) => m.name).join(", ")}. Bạn ghi rõ hơn nhé.`,
    };
  }

  await env.DB.prepare(
    `INSERT INTO bot_sender_aliases (thread_id, sender_norm, sender_name, member_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, sender_norm) DO UPDATE SET
       sender_name = excluded.sender_name,
       member_id = excluded.member_id,
       created_at = excluded.created_at`
  )
    .bind(threadId, senderNorm, senderName, matches[0].id, new Date().toISOString())
    .run();

  return {
    ok: true,
    reply: `✅ Đã ghép "${senderName}" (Messenger) ↔ «${matches[0].name}» (web).\nGiờ "thêm tôi vào buổi" sẽ vào đúng người.`,
  };
}

// --- Liên kết / huỷ liên kết ---

async function handleConnect(env: Env, threadId: string, text: string): Promise<BotReply> {
  const code = text.replace(/^\/connect/i, "").trim().replace(/\s+/g, "");
  if (!code) {
    return {
      ok: false,
      reply: "Cú pháp: /connect <mã>. Lấy mã trong phần Liên kết Messenger trên web TingTing.",
    };
  }

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    "SELECT code, group_id, issued_by, expires_at, used_at FROM bot_link_codes WHERE code = ?"
  )
    .bind(code)
    .first<{ code: string; group_id: string; issued_by: string; expires_at: string; used_at: string | null }>();

  if (!row) return { ok: false, reply: "Mã không đúng. Kiểm tra lại mã trên web nhé." };
  if (row.used_at) return { ok: false, reply: "Mã này đã được dùng rồi. Hãy tạo mã mới trên web." };
  if (row.expires_at < now) return { ok: false, reply: "Mã đã hết hạn. Hãy tạo mã mới trên web." };

  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?")
    .bind(row.group_id)
    .first<{ name: string }>();
  if (!group) return { ok: false, reply: "Nhóm không còn tồn tại." };

  const linkedAt = new Date().toISOString();
  await env.DB.batch([
    // group_id là UNIQUE: gỡ liên kết cũ của nhóm này (nếu đang gắn thread khác) trước khi gắn mới
    env.DB.prepare("DELETE FROM bot_thread_links WHERE group_id = ?").bind(row.group_id),
    env.DB.prepare(
      `INSERT INTO bot_thread_links (thread_id, group_id, linked_by, linked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         group_id = excluded.group_id,
         linked_by = excluded.linked_by,
         linked_at = excluded.linked_at`
    ).bind(threadId, row.group_id, row.issued_by, linkedAt),
    env.DB.prepare("UPDATE bot_link_codes SET used_at = ? WHERE code = ?").bind(linkedAt, code),
  ]);

  return {
    ok: true,
    reply: `✅ Đã liên kết nhóm chat này với «${group.name}». Gõ /play để xem buổi sắp tới, hoặc /help để xem hướng dẫn.`,
  };
}

async function handleDisconnect(env: Env, threadId: string): Promise<BotReply> {
  const result = await env.DB.prepare("DELETE FROM bot_thread_links WHERE thread_id = ?")
    .bind(threadId)
    .run();
  if (result.meta?.changes) {
    return { ok: true, reply: "Đã huỷ liên kết nhóm chat này. Gõ /connect <mã> để liên kết lại." };
  }
  return { ok: true, reply: "Nhóm chat này vốn chưa được liên kết." };
}

// --- Auth + route ---

bot.use("*", async (c, next) => {
  const expected = c.env.BOT_SERVICE_SECRET?.trim();
  if (!expected) return c.json({ error: "Bot service secret is not configured" }, 500);
  const token = bearerToken(c.req.header("Authorization"));
  if (!token || token !== expected) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

// Outbox: bot Python poll tin Worker muốn chủ động gửi (nhắc kèo, báo kèo mới...).
// /outbox/all: mọi thread (cho bot chế độ rover tự phát hiện chat); /outbox?threadId=: một thread.
bot.get("/outbox/all", async (c) => {
  await ensureBotTables(c.env.DB);
  const rows = await c.env.DB.prepare(
    "SELECT id, thread_id, text FROM bot_outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 20"
  ).all<{ id: string; thread_id: string; text: string }>();
  return c.json({ messages: rows.results ?? [] });
});

bot.get("/outbox", async (c) => {
  const threadId = c.req.query("threadId")?.trim();
  if (!threadId) return c.json({ error: "threadId required" }, 400);
  await ensureBotTables(c.env.DB);
  const rows = await c.env.DB.prepare(
    "SELECT id, text FROM bot_outbox WHERE thread_id = ? AND sent_at IS NULL ORDER BY created_at ASC LIMIT 10"
  )
    .bind(threadId)
    .all<{ id: string; text: string }>();
  return c.json({ messages: rows.results ?? [] });
});

bot.post("/outbox/ack", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = (Array.isArray(body?.ids) ? body!.ids : []).filter(
    (x): x is string => typeof x === "string" && x.length > 0
  );
  if (!ids.length) return c.json({ ok: true, acked: 0 });
  await ensureBotTables(c.env.DB);
  const now = new Date().toISOString();
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE bot_outbox SET sent_at = ? WHERE id = ?").bind(now, id)));
  return c.json({ ok: true, acked: ids.length });
});

bot.post("/message", async (c) => {
  const body = await c.req
    .json<{
      threadId?: string;
      senderName?: string;
      text?: string;
      context?: Array<{ role?: string; text?: string }>;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const threadId = body.threadId?.trim();
  const text = (body.text ?? "").trim();
  if (!threadId) return c.json({ error: "threadId required" }, 400);
  if (!text) return c.json({ ok: true, reply: "" });

  // Bot Python gửi kèm các tin gần nhất trong chat — để hiểu "buổi đó", "kèo vừa rồi"...
  const context: BotContextMessage[] = (Array.isArray(body.context) ? body.context : [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_CONTEXT_MESSAGES_FOR_AI)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      text: String(m.text).trim().slice(0, 500),
    }));

  await ensureBotTables(c.env.DB);

  const lower = text.toLowerCase();
  if (lower.startsWith("/connect")) return c.json(await handleConnect(c.env, threadId, text));
  if (lower.startsWith("/disconnect")) return c.json(await handleDisconnect(c.env, threadId));
  if (lower.startsWith("/alias")) {
    return c.json(await handleAlias(c.env, threadId, body.senderName?.trim() || null, text));
  }
  if (lower === "/help" || lower.startsWith("/help ")) return c.json({ ok: true, reply: helpText() });

  return c.json(
    await handleQuery(
      c.env,
      threadId,
      text,
      { name: body.senderName?.trim() || null },
      context.length ? context : undefined
    )
  );
});

export default bot;
