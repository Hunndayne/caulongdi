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

type Intent = "help" | "next" | "upcoming" | "today" | "week" | "recent";

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

type BotReply = { ok: boolean; reply: string };

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
    '• "buổi hôm nay" — buổi trong hôm nay',
    '• "buổi tuần này" — buổi trong tuần',
    '• "buổi kế tiếp" — buổi gần nhất sắp tới',
    '• "các buổi gần đây" — lịch sử gần đây',
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

function detectIntentByRegex(text: string): Intent | null {
  const t = removeDiacritics(text.toLowerCase()).trim();
  if (/^\/help\b/.test(t) || /\b(huong dan|cac lenh|menu|help)\b/.test(t)) return "help";
  if (/\bhom nay\b|\btoday\b/.test(t)) return "today";
  if (/tuan nay|trong tuan|this week/.test(t)) return "week";
  if (/ke tiep|tiep theo|buoi toi|gan nhat|\bnext\b/.test(t)) return "next";
  if (/gan day|lich su|da choi|truoc day|tat ca|\ball\b|\brecent\b/.test(t)) return "recent";
  if (/sap toi|sap dien ra|lich choi|upcoming|^\/buoi\b/.test(t)) return "upcoming";
  return null;
}

// Gọi DeepSeek (API tương thích OpenAI) để phân loại ý định.
async function classifyWithAI(env: Env, text: string): Promise<Intent | null> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;

  const system = [
    "Bạn phân loại ý định câu hỏi về lịch chơi cầu lông của một nhóm.",
    "Chỉ trả lời DUY NHẤT một từ trong: next, upcoming, today, week, recent, help, unknown.",
    "next=buổi sắp tới gần nhất; upcoming=danh sách buổi sắp tới; today=hôm nay; week=tuần này;",
    "recent=các buổi gần đây/lịch sử; help=cần hướng dẫn; unknown=không liên quan.",
  ].join(" ");

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 8,
      stream: false,
    }),
  });

  if (!resp.ok) {
    console.error("[bot-nlu] deepseek http", resp.status, await resp.text().catch(() => ""));
    return null;
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const out = removeDiacritics(String(data?.choices?.[0]?.message?.content ?? "").toLowerCase());
  const labels: Intent[] = ["upcoming", "recent", "today", "week", "next", "help"];
  for (const label of labels) {
    if (out.includes(label)) return label;
  }
  if (out.includes("unknown")) return "help";
  return null;
}

async function resolveQueryIntent(env: Env, text: string): Promise<Intent> {
  const byRegex = detectIntentByRegex(text);
  if (byRegex) return byRegex;

  const cleaned = text.replace(/^\/buoi\b/i, "").trim();
  if (!cleaned) return "upcoming"; // chỉ gõ "/buoi"

  if (!env.DEEPSEEK_API_KEY?.trim()) return "upcoming"; // chưa cấu hình DeepSeek -> mặc định
  if (!(await withinDailyNluCap(env.DB))) return "upcoming"; // chạm trần số lần gọi/ngày
  try {
    return (await classifyWithAI(env, text)) ?? "upcoming";
  } catch (error) {
    console.error("[bot-nlu]", error);
    return "upcoming";
  }
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

async function handleQuery(env: Env, threadId: string, text: string): Promise<BotReply> {
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

  const intent = await resolveQueryIntent(env, text);
  if (intent === "help") return { ok: true, reply: helpText() };

  const today = vnToday();
  let rows: SessionRow[];
  let header: string;

  if (intent === "today") {
    rows = await querySessions(env, link.group_id, { date: today });
    header = `📅 Buổi hôm nay (${formatDate(today)}) của ${groupName}`;
  } else if (intent === "week") {
    const week = vnWeekRange();
    rows = await querySessions(env, link.group_id, { from: week.from, to: week.to });
    header = `📅 Buổi tuần này của ${groupName}`;
  } else if (intent === "recent") {
    rows = await querySessions(env, link.group_id, { recent: true });
    header = `📅 Các buổi gần đây của ${groupName}`;
  } else if (intent === "next") {
    rows = await querySessions(env, link.group_id, { from: today, onlyUpcoming: true, limit: 1 });
    header = `📅 Buổi kế tiếp của ${groupName}`;
  } else {
    rows = await querySessions(env, link.group_id, { from: today, onlyUpcoming: true });
    header = `📅 Buổi sắp tới của ${groupName}`;
  }

  if (rows.length === 0) {
    const none = intent === "recent" ? "Chưa có buổi nào." : "Chưa có buổi nào sắp tới.";
    return { ok: true, reply: `${header}\n${none}` };
  }

  return { ok: true, reply: `${header}\n\n${rows.map(formatSession).join("\n\n")}` };
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

  return c.json(await handleQuery(c.env, threadId, text));
});

export default bot;
