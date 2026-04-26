import { Hono } from "hono";
import { isAdminEmail } from "../admin";
import { Env } from "../types";

const profiles = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type ProfileRow = {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
  role: string;
  phone?: string | null;
  bio?: string | null;
  birthday?: string | null;
  location?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function toProfile(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url ?? undefined,
    role: isAdminEmail(row.email) ? "admin" : row.role,
    phone: row.phone ?? undefined,
    bio: row.bio ?? undefined,
    birthday: row.birthday ?? undefined,
    location: row.location ?? undefined,
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function cleanOptional(value: unknown, maxLength: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id")
  );
}

async function canViewProfile(c: any, targetUserId: string) {
  if (targetUserId === c.get("userId")) return true;
  if (c.get("userRole") === "admin") return true;

  try {
    const shared = await c.env.DB.prepare(`
      SELECT 1
      FROM group_members mine
      JOIN group_members theirs ON theirs.group_id = mine.group_id
      WHERE mine.user_id = ?
        AND theirs.user_id = ?
      LIMIT 1
    `)
      .bind(c.get("userId"), targetUserId)
      .first() as { 1: number } | null;

    return Boolean(shared);
  } catch (error) {
    if (isMissingGroupSchema(error)) return false;
    throw error;
  }
}

const profileSelect = `
  SELECT id, name, email, avatar_url, role, phone, bio, birthday, location, created_at, updated_at
  FROM users
`;

profiles.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
  if (!groupId) return c.json({ error: "groupId required" }, 400);

  try {
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
      ${profileSelect}
      WHERE id IN (
        SELECT gm.user_id
        FROM group_members gm
        WHERE gm.group_id = ?
      )
      ORDER BY name COLLATE NOCASE ASC
    `)
      .bind(groupId)
      .all<ProfileRow>();

    return c.json(rows.results.map(toProfile));
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

profiles.get("/me", async (c) => {
  const row = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(c.get("userId"))
    .first<ProfileRow>();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(toProfile(row));
});

profiles.put("/me", async (c) => {
  const existing = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(c.get("userId"))
    .first<ProfileRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    phone?: string;
    bio?: string;
    birthday?: string;
    location?: string;
    avatarUrl?: string;
  }>();

  if (body.name !== undefined && typeof body.name !== "string") {
    return c.json({ error: "name must be a string" }, 400);
  }

  const name = body.name === undefined ? existing.name : body.name.trim().slice(0, 80);
  if (!name) return c.json({ error: "name required" }, 400);

  const phone = cleanOptional(body.phone, 30);
  const bio = cleanOptional(body.bio, 500);
  const birthday = cleanOptional(body.birthday, 20);
  const location = cleanOptional(body.location, 120);
  const avatarUrl = cleanOptional(body.avatarUrl, 500);
  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    UPDATE users
    SET name = ?, phone = ?, bio = ?, birthday = ?, location = ?, avatar_url = ?, updated_at = ?
    WHERE id = ?
  `)
    .bind(
      name,
      phone === undefined ? existing.phone ?? null : phone,
      bio === undefined ? existing.bio ?? null : bio,
      birthday === undefined ? existing.birthday ?? null : birthday,
      location === undefined ? existing.location ?? null : location,
      avatarUrl === undefined ? existing.avatar_url ?? null : avatarUrl,
      now,
      existing.id
    )
    .run();

  const updated = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(existing.id)
    .first<ProfileRow>();
  return c.json(toProfile(updated!));
});

profiles.get("/:id", async (c) => {
  const { id } = c.req.param();
  if (!(await canViewProfile(c, id))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const row = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(id)
    .first<ProfileRow>();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(toProfile(row));
});

profiles.delete("/:id", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.param();
  if (id === c.get("userId")) {
    return c.json({ error: "Cannot delete your own account" }, 400);
  }

  const row = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(id)
    .first<ProfileRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  if (isAdminEmail(row.email)) {
    return c.json({ error: "Cannot delete the protected admin account" }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET user_id = NULL WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM group_invites WHERE invited_user_id = ? OR invited_by_user_id = ?").bind(id, id),
    c.env.DB.prepare("DELETE FROM group_members WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sessions_auth WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM accounts WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);

  return c.json({ success: true });
});

export default profiles;
