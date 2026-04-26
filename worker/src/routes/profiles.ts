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

const profileSelect = `
  SELECT id, name, email, avatar_url, role, phone, bio, birthday, location, created_at, updated_at
  FROM users
`;

profiles.get("/", async (c) => {
  const rows = await c.env.DB.prepare(`${profileSelect} ORDER BY name COLLATE NOCASE ASC`).all<ProfileRow>();
  return c.json(rows.results.map(toProfile));
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
  const row = await c.env.DB.prepare(`${profileSelect} WHERE id = ?`)
    .bind(id)
    .first<ProfileRow>();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(toProfile(row));
});

export default profiles;
