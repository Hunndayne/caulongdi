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

async function memberHasConfirmedPayments(c: any, memberId: string) {
  const row = await c.env.DB.prepare(`
    SELECT id
    FROM payments
    WHERE (paid = 1 OR payer_marked_paid = 1)
      AND (member_id = ? OR recipient_member_id = ?)
    LIMIT 1
  `)
    .bind(memberId, memberId)
    .first() as { id: string } | null;

  return Boolean(row);
}

members.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
  const memberSelect = `
    SELECT
      m.*,
      u.email AS user_email,
      u.bank_bin AS user_bank_bin,
      u.bank_account_number AS user_bank_account_number,
      u.bank_account_name AS user_bank_account_name
    FROM members m
    LEFT JOIN users u ON u.id = m.user_id
  `;

  const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

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
        ${memberSelect}
        WHERE m.group_id = ?
        ORDER BY m.is_active DESC, m.name ASC
      `)
        .bind(groupId)
        .all();

      const existingMembers = rows.results as any[];
      const existingUserIds = new Set(existingMembers.map((m: any) => m.user_id).filter(Boolean));

      // Find group members who don't have a members record yet
      const ungrouped = await c.env.DB.prepare(`
        SELECT gm.user_id, u.name, u.email
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ?
          AND gm.user_id NOT IN (
            SELECT user_id FROM members WHERE group_id = ? AND user_id IS NOT NULL
          )
      `).bind(groupId, groupId).all<{ user_id: string; name: string | null; email: string }>();

      const newMembers: any[] = [];
      const now = new Date().toISOString();
      for (const gm of ungrouped.results) {
        if (existingUserIds.has(gm.user_id)) continue;
        const total = [...gm.user_id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const avatarColor = MEMBER_COLORS[total % MEMBER_COLORS.length];
        const memberId = nanoid();
        await c.env.DB.prepare(
          "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)"
        ).bind(memberId, groupId, gm.user_id, gm.name || gm.email, avatarColor, now).run();

        const newMember = await c.env.DB.prepare(`${memberSelect} WHERE m.id = ?`).bind(memberId).first();
        if (newMember) newMembers.push(newMember);
      }

      const allMembers = [...existingMembers, ...newMembers];
      allMembers.sort((a: any, b: any) => {
        if (b.is_active !== a.is_active) return b.is_active - a.is_active;
        return (a.name ?? "").localeCompare(b.name ?? "");
      });

      return c.json(allMembers);
    }

    if (c.get("userRole") === "admin") {
      const rows = await c.env.DB.prepare(`
        ${memberSelect}
        ORDER BY m.is_active DESC, m.name ASC
      `).all();
      return c.json(rows.results);
    }

    const rows = await c.env.DB.prepare(`
      ${memberSelect}
      WHERE m.group_id IS NULL
         OR m.group_id IN (
           SELECT gm.group_id
           FROM group_members gm
           WHERE gm.user_id = ?
         )
      ORDER BY m.is_active DESC, m.name ASC
    `)
      .bind(c.get("userId"))
      .all();
    return c.json(rows.results);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      const rows = await c.env.DB.prepare(`
        ${memberSelect}
        ORDER BY m.is_active DESC, m.name ASC
      `).all();
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
  if (await memberHasConfirmedPayments(c, id)) {
    return c.json({
      error: "This member has confirmed payments and cannot be deleted",
    }, 409);
  }
  await c.env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default members;
