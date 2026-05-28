import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";

const chat = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 120;

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

let chatTablesEnsured = false;

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

  const id = nanoid();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, groupId, c.get("userId"), text, now)
    .run();

  const row = await c.env.DB
    .prepare(
      `SELECT cm.id, cm.group_id, cm.user_id, cm.body, cm.created_at,
        u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.id = ?`
    )
    .bind(id)
    .first<ChatMessageRow>();

  return c.json(toChatMessage(row!), 201);
});

export default chat;
