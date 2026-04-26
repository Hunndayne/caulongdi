import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";

const members = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id")
  );
}

members.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();

  try {
    if (groupId) {
      const membership = await c.env.DB.prepare(`
        SELECT role
        FROM group_members
        WHERE group_id = ? AND user_id = ?
      `)
        .bind(groupId, c.get("userId"))
        .first<{ role: string }>();

      if (!membership && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const rows = await c.env.DB.prepare(`
        SELECT *
        FROM members
        WHERE group_id = ?
        ORDER BY is_active DESC, name ASC
      `)
        .bind(groupId)
        .all();
      return c.json(rows.results);
    }

    if (c.get("userRole") === "admin") {
      const rows = await c.env.DB.prepare(
        "SELECT * FROM members ORDER BY is_active DESC, name ASC"
      ).all();
      return c.json(rows.results);
    }

    const rows = await c.env.DB.prepare(`
      SELECT *
      FROM members
      WHERE group_id IS NULL
         OR group_id IN (
           SELECT gm.group_id
           FROM group_members gm
           WHERE gm.user_id = ?
         )
      ORDER BY is_active DESC, name ASC
    `)
      .bind(c.get("userId"))
      .all();
    return c.json(rows.results);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      const rows = await c.env.DB.prepare(
        "SELECT * FROM members ORDER BY is_active DESC, name ASC"
      ).all();
      return c.json(rows.results);
    }
    throw error;
  }
});

members.post("/", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ name: string; phone?: string; avatarColor?: string; userId?: string; groupId?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = nanoid();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  )
    .bind(id, body.groupId ?? null, body.userId ?? null, body.name.trim(), body.phone ?? null, body.avatarColor ?? "#22c55e", now)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  return c.json(row, 201);
});

members.put("/:id", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
  const body = await c.req.json<{ name?: string; phone?: string; avatarColor?: string; isActive?: boolean }>();
  const existing = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare(
    "UPDATE members SET name = ?, phone = ?, avatar_color = ?, is_active = ? WHERE id = ?"
  )
    .bind(
      body.name ?? (existing as any).name,
      body.phone !== undefined ? body.phone : (existing as any).phone,
      body.avatarColor ?? (existing as any).avatar_color,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : (existing as any).is_active,
      id
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  return c.json(row);
});

members.delete("/:id", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
  await c.env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default members;
