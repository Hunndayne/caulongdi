import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";

const groups = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type GroupRow = {
  id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  role: string;
  member_count: number;
  created_at: string;
  updated_at: string;
};

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table: groups") || message.includes("no such column: group_id");
}

function toGroup(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    ownerUserId: row.owner_user_id,
    role: row.role,
    memberCount: row.member_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

groups.get("/", async (c) => {
  try {
    const rows = await c.env.DB.prepare(`
      SELECT g.*,
        gm.role,
        (SELECT COUNT(*) FROM group_members gmc WHERE gmc.group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ?
      ORDER BY g.updated_at DESC, g.name COLLATE NOCASE ASC
    `)
      .bind(c.get("userId"))
      .all<GroupRow>();

    return c.json(rows.results.map(toGroup));
  } catch (error) {
    if (isMissingGroupSchema(error)) return c.json([]);
    throw error;
  }
});

groups.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  const name = body.name?.trim().slice(0, 80);
  const description = body.description?.trim().slice(0, 240) || null;
  if (!name) return c.json({ error: "name required" }, 400);

  const id = nanoid();
  const now = new Date().toISOString();

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO groups (id, name, description, owner_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, name, description, c.get("userId"), now, now),
      c.env.DB.prepare(`
        INSERT INTO group_members (group_id, user_id, role, created_at)
        VALUES (?, ?, 'admin', ?)
      `).bind(id, c.get("userId"), now),
    ]);

    const row = await c.env.DB.prepare(`
      SELECT g.*,
        gm.role,
        (SELECT COUNT(*) FROM group_members gmc WHERE gmc.group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      WHERE g.id = ?
    `)
      .bind(c.get("userId"), id)
      .first<GroupRow>();

    return c.json(toGroup(row!), 201);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.post("/:id/join", async (c) => {
  const { id } = c.req.param();
  const now = new Date().toISOString();

  try {
    const group = await c.env.DB.prepare("SELECT id FROM groups WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!group) return c.json({ error: "Not found" }, 404);

    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
      VALUES (?, ?, 'member', ?)
    `)
      .bind(id, c.get("userId"), now)
      .run();

    return c.json({ success: true });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

export default groups;
