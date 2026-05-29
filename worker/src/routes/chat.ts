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
const TING_CONTEXT_WINDOW_MINUTES = 30;
const TING_CONTEXT_LIMIT = 12;

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

async function getTingConversationContext(db: D1Database, groupId: string, userId: string, before: string) {
  const since = new Date(Date.parse(before) - TING_CONTEXT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `SELECT user_id, body, created_at
       FROM chat_messages
       WHERE group_id = ?
         AND created_at >= ?
         AND created_at < ?
         AND user_id IN (?, ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .bind(groupId, since, before, userId, TING_BOT_USER_ID, TING_CONTEXT_LIMIT)
    .all<TingContextRow>();

  return (rows.results ?? []).reverse().map((row) => ({
    role: row.user_id === TING_BOT_USER_ID ? "assistant" as const : "user" as const,
    text: row.body,
    createdAt: row.created_at,
  }));
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
        const context = await getTingConversationContext(c.env.DB, groupId, c.get("userId"), now);
        const result = await handleGroupBotQuery(c.env, groupId, tingPrompt, {
          userId: c.get("userId"),
          name: sentMessage?.user.name,
        }, context);
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

  return c.json({ messages }, 201);
});

export default chat;
