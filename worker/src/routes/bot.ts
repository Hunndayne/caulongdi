import { Hono } from "hono";
import { Env } from "../types";
import { ensureBotTables } from "../db/botTables";

// Router cho Messenger userbot (server riêng gọi vào).
// Xác thực bằng Bearer BOT_SERVICE_SECRET (DDNS nên không allowlist IP được).
// Bot phía Facebook chỉ làm I/O: forward {threadId, senderName, text} -> nhận {ok, reply} rồi gửi lại chat.

const bot = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const NLU_FEATURE = "bot_nlu";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MAX_NLU_CALLS_PER_DAY = 1000; // trần an toàn chống vòng lặp gọi API tốn tiền
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
  | "create_session"
  | "chat";

type SessionDraft = {
  date?: string;
  startTime?: string;
  venue?: string;
  note?: string;
};

type ParsedIntent = { intent: Intent; names: string[]; session?: SessionDraft };

type SessionRow = {
  id: string;
  date: string;
  start_time: string;
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
};

const SELF_NAME_TOKEN = "__ting_self__";
const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

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

function formatSession(s: SessionRow) {
  const lines = [`🏸 ${formatDate(s.date)} • ${s.start_time} • ${s.venue}`];
  if (s.location) lines.push(`📍 ${s.location}`);
  const status = s.status && s.status !== "upcoming" ? ` • ${statusLabel(s.status)}` : "";
  lines.push(`👥 ${s.attendee_count} người${status}`);
  if (s.note) lines.push(`📝 ${s.note}`);
  return lines.join("\n");
}

function helpText() {
  return [
    "🤖 TingTing bot — các lệnh:",
    "• /buoi — buổi sắp tới của nhóm",
    '• "buổi hôm nay" / "buổi tuần này" / "buổi kế tiếp" — lọc theo thời gian',
    '• "các buổi gần đây" — lịch sử gần đây',
    '• "thành viên" — danh sách thành viên nhóm',
    '• "buổi sắp tới có ai" — ai tham gia buổi sắp tới',
    '• "thêm <tên> vào buổi" — thêm người vào buổi sắp tới',
    "• /connect <mã> — liên kết nhóm chat với nhóm TingTing (lấy mã trên web)",
    "• /disconnect — huỷ liên kết",
  ].join("\n");
}

// --- Trần số lần gọi NLU/ngày (chống vòng lặp tốn tiền). Tái dùng bảng ai_usage_daily. ---

let aiUsageTableEnsured = false;

async function ensureAiUsageTable(db: D1Database) {
  if (aiUsageTableEnsured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ai_usage_daily (
        usage_date TEXT NOT NULL,
        feature TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (usage_date, feature)
      )`
    )
    .run();
  aiUsageTableEnsured = true;
}

async function withinDailyNluCap(db: D1Database): Promise<boolean> {
  await ensureAiUsageTable(db);
  const now = new Date().toISOString();
  const usageDate = now.slice(0, 10); // UTC day

  await db
    .prepare(
      `INSERT OR IGNORE INTO ai_usage_daily (usage_date, feature, estimated_neurons, request_count, updated_at)
       VALUES (?, ?, 0, 0, ?)`
    )
    .bind(usageDate, NLU_FEATURE, now)
    .run();

  const result = await db
    .prepare(
      `UPDATE ai_usage_daily
       SET request_count = request_count + 1, updated_at = ?
       WHERE usage_date = ? AND feature = ? AND request_count < ?`
    )
    .bind(now, usageDate, NLU_FEATURE, MAX_NLU_CALLS_PER_DAY)
    .run();

  return Boolean(result.meta?.changes);
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

function hasSessionContext(t: string): boolean {
  return (
    /^\/buoi\b/.test(t) ||
    /\b(buoi|lich|choi|cau long|san|tap)\b/.test(t) ||
    /\b(di danh|danh cau|danh o|di cau)\b/.test(t)
  );
}

function detectIntentByRegex(text: string): Intent | null {
  const t = removeDiacritics(text.toLowerCase()).trim();
  const sessionContext = hasSessionContext(t);
  if (/^\/help\b/.test(t) || /\b(huong dan|cac lenh|menu)\b/.test(t)) return "help";
  if (/^\/thanhvien\b|thanh vien|ai trong nhom|danh sach (thanh vien|nguoi)/.test(t)) return "list_members";
  if (/\b(ai tham gia|ai danh|ai choi|ai di)\b/.test(t) || (sessionContext && /\b(co ai|co nhung ai|nhung ai)\b/.test(t))) {
    return "list_attendees";
  }
  if (sessionContext && (/\bhom nay\b|\btoday\b/.test(t))) return "today";
  if (sessionContext && /tuan nay|trong tuan|this week/.test(t)) return "week";
  if (sessionContext && /ke tiep|tiep theo|buoi toi|gan nhat|\bnext\b/.test(t)) return "next";
  if (sessionContext && /gan day|lich su|da choi|truoc day|tat ca|\ball\b|\brecent\b/.test(t)) return "recent";
  if (/^\/buoi\b/.test(t) || (sessionContext && /sap toi|sap dien ra|lich choi|upcoming/.test(t))) return "upcoming";
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
    "create_session",
    "help",
    "chat",
  ];
  if ((valid as string[]).includes(v)) return v as Intent;
  if (v === "unknown" || v === "smalltalk" || v === "general") return "chat";
  return null;
}

// Gọi DeepSeek (API tương thích OpenAI) để phân loại ý định + rút tên người (cho add_member).
async function classifyWithAI(env: Env, text: string, actor?: BotActor): Promise<ParsedIntent | null> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;

  const system = [
    `Nếu người dùng nói tôi/mình/tui/em/anh/chị để chỉ chính người gửi, trả names ["${SELF_NAME_TOKEN}"].`,
    "Nếu người dùng muốn tạo/set/lên kèo/buổi/lịch mới, intent là create_session.",
    "Only classify today/week/upcoming/next/recent/list_attendees when the user clearly asks about badminton sessions, schedule, court, or players; casual chat that happens to mention time words must be unknown.",
    "Bạn phân tích câu của người dùng về lịch chơi cầu lông của một nhóm và TRẢ VỀ JSON.",
    'Định dạng JSON: {"intent": "...", "names": ["..."]}.',
    "intent là MỘT trong: next, upcoming, today, week, recent, list_members, list_attendees, add_member, create_session, help, unknown.",
    "Ý nghĩa: next=buổi sắp tới gần nhất; upcoming=danh sách buổi sắp tới; today=hôm nay; week=tuần này; recent=các buổi gần đây/lịch sử;",
    "list_members=liệt kê thành viên nhóm; list_attendees=ai tham gia buổi; add_member=thêm người vào buổi; create_session=tạo buổi/kèo mới; help=hướng dẫn; unknown=không liên quan.",
    'names CHỈ điền khi intent=add_member: danh sách tên người cần thêm, ví dụ ["An","Bình"]. Các intent khác để names rỗng [].',
  ].join(" ");

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Người gửi: ${actor?.name || actor?.userId || "không rõ"}\nTin nhắn: ${text}` },
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
  let obj: { intent?: unknown; names?: unknown };
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
  return { intent, names };
}

function naturalChatFallback(groupName: string) {
  return [
    `Mình đang ở đây với ${groupName} nè.`,
    "Câu này hơi ngoài phần lịch chơi nên mình chưa trả lời sâu được lúc này. Hỏi mình kiểu tự nhiên tiếp đi, hoặc hỏi về buổi chơi/thành viên thì mình xử ngay.",
  ].join("\n");
}

async function replyNaturalChat(env: Env, groupName: string, text: string, actor?: BotActor): Promise<BotReply> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return { ok: true, reply: naturalChatFallback(groupName) };
  if (!(await withinDailyNluCap(env.DB))) return { ok: true, reply: naturalChatFallback(groupName) };

  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const system = [
    "Bạn là Ting AI trong group chat của một nhóm cầu lông trên TingTing.",
    "Trả lời tự nhiên, thân thiện, vui vừa phải, bằng tiếng Việt.",
    "Ưu tiên câu trả lời ngắn gọn 1-4 câu, hợp văn cảnh chat nhóm.",
    "Nếu người dùng hỏi về lịch chơi, thành viên, ai tham gia, hoặc thêm người vào buổi thì nhắc họ có thể hỏi trực tiếp bằng /ting.",
    "Không tự bịa dữ liệu lịch, công nợ, thành viên nếu không được cung cấp trong tin nhắn.",
  ].join(" ");

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Nhóm: ${groupName}\nNgười gửi: ${actor?.name || actor?.userId || "không rõ"}\nTin nhắn: ${text}` },
      ],
      temperature: 0.7,
      max_tokens: 450,
      stream: false,
    }),
  });

  if (!resp.ok) {
    console.error("[bot-chat] deepseek http", resp.status, await resp.text().catch(() => ""));
    return { ok: true, reply: naturalChatFallback(groupName) };
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return { ok: true, reply: reply ? reply.slice(0, 1600) : naturalChatFallback(groupName) };
}

async function resolveIntent(env: Env, text: string, actor?: BotActor): Promise<ParsedIntent> {
  const t = removeDiacritics(text.toLowerCase()).trim();
  const createLike = isCreateSessionLike(t);
  const addLike = isAddLike(t);

  if (createLike) {
    return { intent: "create_session", names: [], session: parseCreateSessionDraft(text) };
  }

  if (!addLike) {
    const byRegex = detectIntentByRegex(text);
    if (byRegex) return { intent: byRegex, names: [] };

    const cleaned = text.replace(/^\/buoi\b/i, "").trim();
    if (!cleaned) return { intent: "upcoming", names: [] }; // chỉ gõ "/buoi"
  }

  // Gọi DeepSeek nếu có cấu hình & chưa chạm trần.
  let ai: ParsedIntent | null = null;
  if (env.DEEPSEEK_API_KEY?.trim() && (await withinDailyNluCap(env.DB))) {
    try {
      ai = await classifyWithAI(env, text, actor);
    } catch (error) {
      console.error("[bot-nlu]", error);
    }
  }

  if (addLike) {
    // Luôn xử lý như "thêm". Ưu tiên tên DeepSeek rút được; không có thì tự tách tên.
    const names = normalizeAddNames(text, ai?.intent === "add_member" ? ai.names : []);
    return { intent: "add_member", names };
  }

  if (ai?.intent === "create_session") {
    return { intent: "create_session", names: [], session: parseCreateSessionDraft(text) };
  }

  return ai ?? { intent: "chat", names: [] };
}

// --- Truy vấn buổi chơi ---

type QueryOpts = {
  date?: string;
  from?: string;
  to?: string;
  onlyUpcoming?: boolean;
  recent?: boolean;
  limit?: number;
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
  if (opts.onlyUpcoming) {
    where.push("s.status = 'upcoming'");
  }

  const order = opts.recent
    ? "ORDER BY s.date DESC, s.start_time DESC"
    : "ORDER BY s.date ASC, s.start_time ASC";
  const limit = Math.max(1, Math.floor(opts.limit ?? MAX_SESSIONS_IN_REPLY));

  const sql = `
    SELECT s.id, s.date, s.start_time, s.venue, s.location, s.note, s.status,
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

async function handleQuery(env: Env, threadId: string, text: string, actor?: BotActor): Promise<BotReply> {
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

  const parsed = await resolveIntent(env, text, actor);

  switch (parsed.intent) {
    case "help":
      return { ok: true, reply: helpText() };
    case "list_members":
      return replyMembers(env, groupId, groupName);
    case "list_attendees":
      return replyAttendees(env, groupId, groupName);
    case "add_member":
      return replyAddMembers(env, groupId, groupName, parsed.names, actor);
    case "create_session":
      return replyCreateSession(env, groupId, groupName, parsed.session, actor);
    case "chat":
      return replyNaturalChat(env, groupName, text, actor);
    default:
      return replySessions(env, groupId, groupName, parsed.intent);
  }
}

export async function handleGroupBotQuery(env: Env, groupId: string, text: string, actor?: BotActor): Promise<BotReply> {
  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?")
    .bind(groupId)
    .first<{ name: string }>();
  const groupName = group?.name ?? "nhom";

  const parsed = await resolveIntent(env, text, actor);

  switch (parsed.intent) {
    case "help":
      return { ok: true, reply: helpText() };
    case "list_members":
      return replyMembers(env, groupId, groupName);
    case "list_attendees":
      return replyAttendees(env, groupId, groupName);
    case "add_member":
      return replyAddMembers(env, groupId, groupName, parsed.names, actor);
    case "create_session":
      return replyCreateSession(env, groupId, groupName, parsed.session, actor);
    case "chat":
      return replyNaturalChat(env, groupName, text, actor);
    default:
      return replySessions(env, groupId, groupName, parsed.intent);
  }
}

async function replySessions(env: Env, groupId: string, groupName: string, intent: Intent): Promise<BotReply> {
  const today = vnToday();
  let rows: SessionRow[];
  let header: string;

  if (intent === "today") {
    rows = await querySessions(env, groupId, { date: today });
    header = `📅 Buổi hôm nay (${formatDate(today)}) của ${groupName}`;
  } else if (intent === "week") {
    const week = vnWeekRange();
    rows = await querySessions(env, groupId, { from: week.from, to: week.to });
    header = `📅 Buổi tuần này của ${groupName}`;
  } else if (intent === "recent") {
    rows = await querySessions(env, groupId, { recent: true });
    header = `📅 Các buổi gần đây của ${groupName}`;
  } else if (intent === "next") {
    // "Sắp tới" theo status (giống badge trên web), không lọc theo ngày.
    rows = await querySessions(env, groupId, { onlyUpcoming: true, limit: 1 });
    header = `📅 Buổi kế tiếp của ${groupName}`;
  } else {
    rows = await querySessions(env, groupId, { onlyUpcoming: true });
    header = `📅 Buổi sắp tới của ${groupName}`;
  }

  if (rows.length === 0) {
    const none = intent === "recent" ? "Chưa có buổi nào." : "Chưa có buổi nào sắp tới.";
    return { ok: true, reply: `${header}\n${none}` };
  }

  return { ok: true, reply: `${header}\n\n${rows.map(formatSession).join("\n\n")}` };
}

async function replyMembers(env: Env, groupId: string, groupName: string): Promise<BotReply> {
  const result = await env.DB
    .prepare("SELECT name FROM members WHERE group_id = ? AND is_active = 1 ORDER BY name COLLATE NOCASE")
    .bind(groupId)
    .all<{ name: string }>();
  const members = result.results ?? [];
  if (!members.length) return { ok: true, reply: `Nhóm ${groupName} chưa có thành viên nào.` };
  const list = members.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
  return { ok: true, reply: `👥 Thành viên nhóm ${groupName} (${members.length}):\n${list}` };
}

async function replyAttendees(env: Env, groupId: string, groupName: string): Promise<BotReply> {
  const session = await soonestUpcoming(env, groupId);
  if (!session) return { ok: true, reply: `${groupName}: chưa có buổi sắp tới nào.` };

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
  const header = `🏸 ${formatDate(session.date)} • ${session.start_time} • ${session.venue}`;
  if (!names.length) return { ok: true, reply: `${header}\nChưa có ai tham gia.` };
  const list = names.map((n) => `• ${n.name}`).join("\n");
  return { ok: true, reply: `${header}\n👥 ${names.length} người tham gia:\n${list}` };
}

async function replyCreateSession(
  env: Env,
  groupId: string,
  groupName: string,
  draft?: SessionDraft,
  actor?: BotActor
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
    `SELECT s.id, s.date, s.start_time, s.venue, s.location, s.note, s.status,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count
     FROM sessions s
     WHERE s.group_id = ? AND s.date = ? AND s.start_time = ? AND lower(s.venue) = lower(?) AND s.status = 'upcoming'
     LIMIT 1`
  )
    .bind(groupId, sessionDate, startTime, venue)
    .first<SessionRow>();

  if (existing) {
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

  return {
    ok: true,
    reply: `✅ Đã tạo kèo mới cho ${groupName}:\n${formatSession(session)}\nAi đi thì nhắn "/ting thêm tôi vào buổi" nhé.`,
  };
}

async function replyAddMembers(
  env: Env,
  groupId: string,
  groupName: string,
  names: string[],
  actor?: BotActor
): Promise<BotReply> {
  if (!names.length) {
    return { ok: false, reply: 'Bạn muốn thêm ai? Ví dụ: "thêm An vào buổi".' };
  }

  const session = await soonestUpcoming(env, groupId);
  if (!session) return { ok: true, reply: `${groupName}: chưa có buổi sắp tới nào để thêm người.` };

  const selfMember =
    names.includes(SELF_NAME_TOKEN) && actor?.userId ? await getOrCreateMemberForUser(env, groupId, actor.userId) : null;

  const members =
    (await env.DB.prepare("SELECT id, name FROM members WHERE group_id = ? AND is_active = 1")
      .bind(groupId)
      .all<{ id: string; name: string }>()).results ?? [];
  const attendingRows =
    (await env.DB.prepare("SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1")
      .bind(session.id)
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
        .bind(session.id, memberId)
    );
    // Xoá payment chưa trả để tính lại chia tiền (giống flow join/điểm danh của app).
    stmts.push(env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(session.id));
    await env.DB.batch(stmts);
  }

  const header = `🏸 ${formatDate(session.date)} • ${session.start_time} • ${session.venue}`;
  const lines = [header];
  if (added.length) lines.push(`✅ Đã thêm: ${added.join(", ")}`);
  if (already.length) lines.push(`ℹ️ Đã có sẵn: ${already.join(", ")}`);
  if (ambiguous.length) lines.push(`⚠️ Trùng tên, ghi rõ hơn: ${ambiguous.join(", ")}`);
  if (notFound.length) lines.push(`❓ Không tìm thấy: ${notFound.join(", ")} (gõ "thành viên" để xem danh sách)`);
  return { ok: true, reply: lines.join("\n") };
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
    reply: `✅ Đã liên kết nhóm chat này với «${group.name}». Gõ /buoi để xem buổi sắp tới, hoặc /help để xem hướng dẫn.`,
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

bot.post("/message", async (c) => {
  const body = await c.req
    .json<{ threadId?: string; senderName?: string; text?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const threadId = body.threadId?.trim();
  const text = (body.text ?? "").trim();
  if (!threadId) return c.json({ error: "threadId required" }, 400);
  if (!text) return c.json({ ok: true, reply: "" });

  await ensureBotTables(c.env.DB);

  const lower = text.toLowerCase();
  if (lower.startsWith("/connect")) return c.json(await handleConnect(c.env, threadId, text));
  if (lower.startsWith("/disconnect")) return c.json(await handleDisconnect(c.env, threadId));
  if (lower === "/help" || lower.startsWith("/help ")) return c.json({ ok: true, reply: helpText() });

  return c.json(await handleQuery(c.env, threadId, text, { name: body.senderName?.trim() || null }));
});

export default bot;
