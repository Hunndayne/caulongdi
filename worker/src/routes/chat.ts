import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";
import { handleGroupBotQuery } from "./bot";

const chat = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 120;
const TING_BOT_USER_ID = "tingting-bot";
const TING_BOT_EMAIL = "ting@tingting.local";
const TING_BOT_NAME = "Ting AI";
const TING_CONTEXT_WINDOW_MINUTES = 60;
const TING_CONTEXT_LIMIT = 20;
const TING_SUMMARY_UPDATE_THRESHOLD = 20;
const TING_SUMMARY_BATCH_SIZE = 80;

type ChatMessageRow = {
  id: string;
  group_id: string;
  user_id: string;
  body: string;
  created_at: string;
  user_name: string;
  user_email: string;
  user_avatar_url?: string | null;
};

type TingContextRow = {
  user_id: string;
  body: string;
  created_at: string;
  user_name: string;
};

type GroupChatSummaryRow = {
  summary: string;
  group_style: string;
  last_message_id: string | null;
  message_count: number;
  generated_at: string;
};

type GroupChatSummary = {
  summary: string;
  groupStyle: string;
  lastMessageId: string | null;
  messageCount: number;
};

let chatTablesEnsured = false;
let tingBotUserEnsured = false;

async function ensureChatTables(db: D1Database) {
  if (chatTablesEnsured) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_chat_messages_group_created ON chat_messages(group_id, created_at)")
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS group_chat_summaries (
        group_id       TEXT PRIMARY KEY,
        summary        TEXT NOT NULL DEFAULT '',
        group_style    TEXT NOT NULL DEFAULT '',
        last_message_id TEXT,
        message_count  INTEGER NOT NULL DEFAULT 0,
        generated_at   TEXT NOT NULL
      )`
    )
    .run();

  chatTablesEnsured = true;
}

async function ensureTingBotUser(db: D1Database) {
  if (tingBotUserEnsured) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (
        id, name, email, email_verified, avatar_url, role, created_at, updated_at
      ) VALUES (?, ?, ?, 1, NULL, 'member', ?, ?)`
    )
    .bind(TING_BOT_USER_ID, TING_BOT_NAME, TING_BOT_EMAIL, now, now)
    .run();
  tingBotUserEnsured = true;
}

function toChatMessage(row: ChatMessageRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    body: row.body,
    createdAt: row.created_at,
    user: {
      name: row.user_name,
      email: row.user_email,
      avatarUrl: row.user_avatar_url ?? undefined,
    },
  };
}

async function getMembership(c: any, groupId: string) {
  const membership = (await c.env.DB.prepare(
    "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"
  )
    .bind(groupId, c.get("userId"))
    .first()) as { role: string } | null;

  if (membership) return membership.role;
  return c.get("userRole") === "admin" ? "admin" : null;
}

function parseLimit(raw?: string) {
  const value = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function parseTingPrompt(text: string) {
  if (!/^\/ting(?:\s|$)/i.test(text)) return null;
  return text.replace(/^\/ting\s*/i, "").trim();
}

async function getChatMessage(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT cm.id, cm.group_id, cm.user_id, cm.body, cm.created_at,
        u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.id = ?`
    )
    .bind(id)
    .first<ChatMessageRow>();

  return row ? toChatMessage(row) : null;
}

async function insertChatMessage(db: D1Database, groupId: string, userId: string, body: string, createdAt: string) {
  const id = nanoid();
  await db
    .prepare("INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, groupId, userId, body, createdAt)
    .run();

  return getChatMessage(db, id);
}

// Lấy context cuộc trò chuyện gần đây của TẤT CẢ thành viên trong nhóm (không chỉ user + bot),
// có tên người gửi để AI phân biệt ai nói gì.
async function getTingConversationContext(db: D1Database, groupId: string, before: string) {
  const since = new Date(Date.parse(before) - TING_CONTEXT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `SELECT cm.user_id, cm.body, cm.created_at, u.name as user_name
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.group_id = ?
         AND cm.created_at >= ?
         AND cm.created_at < ?
       ORDER BY cm.created_at DESC, cm.id DESC
       LIMIT ?`
    )
    .bind(groupId, since, before, TING_CONTEXT_LIMIT)
    .all<TingContextRow>();

  return (rows.results ?? []).reverse().map((row) => ({
    role: row.user_id === TING_BOT_USER_ID ? "assistant" as const : "user" as const,
    text: row.body,
    createdAt: row.created_at,
    userName: row.user_id === TING_BOT_USER_ID ? "Ting AI" : row.user_name,
  }));
}

// --- Group chat summary (Tầng 2 & 3) ---

async function getGroupChatSummary(db: D1Database, groupId: string): Promise<GroupChatSummary | null> {
  const row = await db
    .prepare(
      `SELECT summary, group_style, last_message_id, message_count, generated_at
       FROM group_chat_summaries WHERE group_id = ?`
    )
    .bind(groupId)
    .first<GroupChatSummaryRow>();

  if (!row) return null;

  return {
    summary: row.summary,
    groupStyle: row.group_style || "",
    lastMessageId: row.last_message_id,
    messageCount: row.message_count,
  };
}

// Đếm tin nhắn mới kể từ lần tổng hợp cuối (để biết có cần cập nhật không).
async function countNewMessagesSince(db: D1Database, groupId: string, sinceMessageId: string | null): Promise<number> {
  if (!sinceMessageId) {
    const row = await db
      .prepare("SELECT COUNT(*) as cnt FROM chat_messages WHERE group_id = ?")
      .bind(groupId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  const lastMsg = await db
    .prepare("SELECT created_at FROM chat_messages WHERE id = ?")
    .bind(sinceMessageId)
    .first<{ created_at: string }>();

  if (!lastMsg) return 0;

  const row = await db
    .prepare("SELECT COUNT(*) as cnt FROM chat_messages WHERE group_id = ? AND created_at > ?")
    .bind(groupId, lastMsg.created_at)
    .first<{ cnt: number }>();

  return row?.cnt ?? 0;
}

// Gọi AI để phân tích đoạn chat và tổng hợp: chủ đề nhóm + phong cách chat chung của cả nhóm.
async function generateGroupSummaryWithAI(
  env: Env,
  messages: Array<{ userId: string; userName: string; body: string }>
): Promise<{ summary: string; groupStyle: string } | null> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey || messages.length === 0) return null;

  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";

  const chatLog = messages
    .filter((m) => m.userId !== TING_BOT_USER_ID)
    .map((m) => `${m.userName}: ${m.body.slice(0, 200)}`)
    .join("\n");

  if (!chatLog.trim()) return null;

  const system = [
    "Bạn phân tích đoạn chat nhóm cầu lông tiếng Việt và trả về JSON.",
    "Nhiệm vụ: (1) Tóm tắt ngắn gọn các chủ đề, sự kiện nổi bật của nhóm gần đây (tối đa 2 câu).",
    "(2) Mô tả TÍNH CÁCH/PHONG CÁCH CHAT CHUNG của cả nhóm (không phải từng người) — mức độ đùa giỡn, thân mật, hay dùng teencode/emoji, không khí chung (tối đa 2-3 câu).",
    'Trả về JSON: {"summary": "...", "groupStyle": "..."}.',
    "groupStyle dùng để bot bắt chước tông giọng khi trả lời cho hợp không khí nhóm. Không bịa nếu không đủ dữ liệu. Cả hai đều bằng tiếng Việt.",
  ].join(" ");

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Đoạn chat:\n${chatLog}` },
        ],
        // Thinking mode không nhận temperature; max_tokens nâng lên để chừa chỗ cho chuỗi suy luận.
        thinking: { type: "enabled" },
        max_tokens: 1200,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });

    if (!resp.ok) {
      console.error("[group-summary] deepseek http", resp.status);
      return null;
    }

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content ?? "";
    const obj = JSON.parse(content) as { summary?: unknown; groupStyle?: unknown };

    return {
      summary: typeof obj.summary === "string" ? obj.summary.trim().slice(0, 400) : "",
      groupStyle: typeof obj.groupStyle === "string" ? obj.groupStyle.trim().slice(0, 400) : "",
    };
  } catch (error) {
    console.error("[group-summary]", error);
    return null;
  }
}

// Kiểm tra và cập nhật summary nếu đủ tin mới. Gọi sau khi insert message.
async function maybeUpdateGroupSummary(env: Env, groupId: string, latestMessageId: string): Promise<void> {
  try {
    const current = await getGroupChatSummary(env.DB, groupId);
    const newCount = await countNewMessagesSince(env.DB, groupId, current?.lastMessageId ?? null);

    if (newCount < TING_SUMMARY_UPDATE_THRESHOLD) return;

    const rows = await env.DB
      .prepare(
        `SELECT cm.id, cm.user_id, cm.body, u.name as user_name
         FROM chat_messages cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.group_id = ?
         ORDER BY cm.created_at DESC, cm.id DESC
         LIMIT ?`
      )
      .bind(groupId, TING_SUMMARY_BATCH_SIZE)
      .all<{ id: string; user_id: string; body: string; user_name: string }>();

    const messages = (rows.results ?? []).reverse().map((r) => ({
      userId: r.user_id,
      userName: r.user_name,
      body: r.body,
    }));

    const generated = await generateGroupSummaryWithAI(env, messages);
    if (!generated) return;

    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `INSERT INTO group_chat_summaries
           (group_id, summary, group_style, last_message_id, message_count, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           summary = excluded.summary,
           group_style = excluded.group_style,
           last_message_id = excluded.last_message_id,
           message_count = excluded.message_count,
           generated_at = excluded.generated_at`
      )
      .bind(groupId, generated.summary, generated.groupStyle, latestMessageId, messages.length, now)
      .run();
  } catch (error) {
    console.error("[group-summary] update failed", error);
  }
}

// Định dạng summary thành chuỗi để truyền vào AI prompt.
function formatGroupSummaryForPrompt(summary: GroupChatSummary | null): string {
  if (!summary || !summary.summary) return "";

  const parts: string[] = [`Tóm tắt nhóm: ${summary.summary}`];

  if (summary.groupStyle) {
    parts.push(`Phong cách/tính cách chat của nhóm: ${summary.groupStyle}`);
  }

  return parts.join("\n");
}

chat.get("/:groupId/messages", async (c) => {
  const groupId = c.req.param("groupId");
  const membership = await getMembership(c, groupId);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  await ensureChatTables(c.env.DB);

  const limit = parseLimit(c.req.query("limit"));
  const rows = await c.env.DB
    .prepare(
      `SELECT cm.id, cm.group_id, cm.user_id, cm.body, cm.created_at,
        u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.group_id = ?
       ORDER BY cm.created_at DESC, cm.id DESC
       LIMIT ?`
    )
    .bind(groupId, limit)
    .all<ChatMessageRow>();

  return c.json(rows.results.reverse().map(toChatMessage));
});

chat.post("/:groupId/messages", async (c) => {
  const groupId = c.req.param("groupId");
  const membership = await getMembership(c, groupId);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ body?: string }>().catch(() => null);
  const text = body?.body?.trim() ?? "";
  if (!text) return c.json({ error: "Message is required" }, 400);
  if (text.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or less` }, 400);
  }

  await ensureChatTables(c.env.DB);

  const now = new Date().toISOString();
  const sentMessage = await insertChatMessage(c.env.DB, groupId, c.get("userId"), text, now);
  const messages = sentMessage ? [sentMessage] : [];

  const tingPrompt = parseTingPrompt(text);
  if (tingPrompt !== null) {
    await ensureTingBotUser(c.env.DB);

    let reply = "";
    if (!tingPrompt) {
      reply = 'Gõ sau /ting điều bạn muốn hỏi. Ví dụ: "/ting buổi tuần này" hoặc "/ting buổi sắp tới có ai".';
    } else {
      try {
        const [context, groupSummary] = await Promise.all([
          getTingConversationContext(c.env.DB, groupId, now),
          getGroupChatSummary(c.env.DB, groupId),
        ]);
        const formattedSummary = formatGroupSummaryForPrompt(groupSummary);
        const result = await handleGroupBotQuery(
          c.env,
          groupId,
          tingPrompt,
          { userId: c.get("userId"), name: sentMessage?.user.name },
          context,
          formattedSummary || undefined
        );
        reply = result.reply || "Mình chưa có câu trả lời cho câu này.";
      } catch (error) {
        console.error("[web-chat-ting]", error);
        reply = "Ting đang hơi lag, thử lại giúp mình nhé.";
      }
    }

    const replyAt = new Date(Date.now() + 1).toISOString();
    const botMessage = await insertChatMessage(c.env.DB, groupId, TING_BOT_USER_ID, reply, replyAt);
    if (botMessage) messages.push(botMessage);
  }

  // Cập nhật summary bất đồng bộ sau khi đã có đủ tin mới (không block response).
  if (sentMessage?.id) {
    c.executionCtx.waitUntil(maybeUpdateGroupSummary(c.env, groupId, sentMessage.id));
  }

  return c.json({ messages }, 201);
});

export default chat;
