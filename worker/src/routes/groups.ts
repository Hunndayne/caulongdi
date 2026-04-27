import { Hono } from "hono";
import { sendGroupInviteNotification } from "../email";
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

type GroupMemberRow = {
  user_id: string;
  role: string;
  created_at: string;
  name: string;
  email: string;
  avatar_url?: string | null;
};

type GroupInviteRow = {
  id: string;
  group_id: string;
  group_name: string;
  group_description?: string | null;
  invited_user_id: string;
  invited_user_name?: string | null;
  invited_user_email?: string | null;
  invited_user_avatar_url?: string | null;
  invited_by_user_id: string;
  invited_by_name: string;
  invited_by_email: string;
  role: string;
  status: string;
  created_at: string;
  responded_at?: string | null;
};

type SearchUserRow = {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
  pending_invite_id?: string | null;
};

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such table: group_invites") ||
    message.includes("no such column: group_id")
  );
}

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

async function getMembership(c: any, groupId: string) {
  const membership = await c.env.DB.prepare(`
    SELECT gm.role
    FROM group_members gm
    WHERE gm.group_id = ? AND gm.user_id = ?
  `)
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;

  if (membership) return membership.role;
  return c.get("userRole") === "admin" ? "admin" : null;
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

function toGroupMember(row: GroupMemberRow) {
  return {
    userId: row.user_id,
    role: row.role,
    joinedAt: row.created_at,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url ?? undefined,
  };
}

function toGroupInvite(row: GroupInviteRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    groupDescription: row.group_description ?? undefined,
    invitedUserId: row.invited_user_id,
    invitedUserName: row.invited_user_name ?? undefined,
    invitedUserEmail: row.invited_user_email ?? undefined,
    invitedUserAvatarUrl: row.invited_user_avatar_url ?? undefined,
    invitedByUserId: row.invited_by_user_id,
    invitedByName: row.invited_by_name,
    invitedByEmail: row.invited_by_email,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
  };
}

function toSearchUser(row: SearchUserRow) {
  return {
    userId: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url ?? undefined,
    inviteStatus: row.pending_invite_id ? "pending" : "none",
    pendingInviteId: row.pending_invite_id ?? undefined,
  };
}

groups.get("/invites/received", async (c) => {
  try {
    const rows = await c.env.DB.prepare(`
      SELECT
        gi.id,
        gi.group_id,
        g.name as group_name,
        g.description as group_description,
        gi.invited_user_id,
        invitee.name as invited_user_name,
        invitee.email as invited_user_email,
        invitee.avatar_url as invited_user_avatar_url,
        gi.invited_by_user_id,
        inviter.name as invited_by_name,
        inviter.email as invited_by_email,
        gi.role,
        gi.status,
        gi.created_at,
        gi.responded_at
      FROM group_invites gi
      JOIN groups g ON g.id = gi.group_id
      JOIN users invitee ON invitee.id = gi.invited_user_id
      JOIN users inviter ON inviter.id = gi.invited_by_user_id
      WHERE gi.invited_user_id = ?
        AND gi.status = 'pending'
      ORDER BY gi.created_at DESC
    `)
      .bind(c.get("userId"))
      .all<GroupInviteRow>();

    return c.json(rows.results.map(toGroupInvite));
  } catch (error) {
    if (isMissingGroupSchema(error)) return c.json([]);
    throw error;
  }
});

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

groups.get("/:id/members", async (c) => {
  const { id } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (!membership) return c.json({ error: "Forbidden" }, 403);

    const rows = await c.env.DB.prepare(`
      SELECT
        gm.user_id,
        gm.role,
        gm.created_at,
        u.name,
        u.email,
        u.avatar_url
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY
        CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END,
        u.name COLLATE NOCASE ASC
    `)
      .bind(id)
      .all<GroupMemberRow>();

    return c.json(rows.results.map(toGroupMember));
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.get("/:id/invites", async (c) => {
  const { id } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    const rows = await c.env.DB.prepare(`
      SELECT
        gi.id,
        gi.group_id,
        g.name as group_name,
        g.description as group_description,
        gi.invited_user_id,
        invitee.name as invited_user_name,
        invitee.email as invited_user_email,
        invitee.avatar_url as invited_user_avatar_url,
        gi.invited_by_user_id,
        inviter.name as invited_by_name,
        inviter.email as invited_by_email,
        gi.role,
        gi.status,
        gi.created_at,
        gi.responded_at
      FROM group_invites gi
      JOIN groups g ON g.id = gi.group_id
      JOIN users invitee ON invitee.id = gi.invited_user_id
      JOIN users inviter ON inviter.id = gi.invited_by_user_id
      WHERE gi.group_id = ?
        AND gi.status = 'pending'
      ORDER BY gi.created_at DESC
    `)
      .bind(id)
      .all<GroupInviteRow>();

    return c.json(rows.results.map(toGroupInvite));
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.get("/:id/search-users", async (c) => {
  const { id } = c.req.param();
  const q = c.req.query("q")?.trim().toLowerCase() ?? "";

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);
    if (q.length < 2) return c.json([]);

    const like = `%${q}%`;
    const rows = await c.env.DB.prepare(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        (
          SELECT gi.id
          FROM group_invites gi
          WHERE gi.group_id = ?
            AND gi.invited_user_id = u.id
            AND gi.status = 'pending'
          LIMIT 1
        ) as pending_invite_id
      FROM users u
      WHERE u.id != ?
        AND (
          lower(u.name) LIKE ?
          OR lower(u.email) LIKE ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM group_members gm
          WHERE gm.group_id = ?
            AND gm.user_id = u.id
        )
      ORDER BY
        CASE WHEN pending_invite_id IS NULL THEN 0 ELSE 1 END,
        u.name COLLATE NOCASE ASC
      LIMIT 8
    `)
      .bind(id, c.get("userId"), like, like, id)
      .all<SearchUserRow>();

    return c.json(rows.results.map(toSearchUser));
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
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

groups.post("/:id/invites", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ userId?: string; role?: "admin" | "member" }>();
  const invitedUserId = body.userId?.trim();
  const role = body.role === "admin" ? "admin" : "member";
  if (!invitedUserId) return c.json({ error: "userId required" }, 400);

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);
    if (invitedUserId === c.get("userId")) {
      return c.json({ error: "Cannot invite yourself" }, 400);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, name, email, avatar_url
      FROM users
      WHERE id = ?
    `)
      .bind(invitedUserId)
      .first<{ id: string; name: string; email: string; avatar_url?: string | null }>();
    if (!user) return c.json({ error: "User not found" }, 404);

    const existingMember = await c.env.DB.prepare(`
      SELECT user_id
      FROM group_members
      WHERE group_id = ? AND user_id = ?
    `)
      .bind(id, invitedUserId)
      .first<{ user_id: string }>();
    if (existingMember) return c.json({ error: "User is already in this group" }, 400);

    const inviteId = nanoid();
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO group_invites (
          id, group_id, invited_user_id, invited_by_user_id, role, status, created_at, responded_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)
        ON CONFLICT(group_id, invited_user_id)
        DO UPDATE SET
          id = excluded.id,
          invited_by_user_id = excluded.invited_by_user_id,
          role = excluded.role,
          status = 'pending',
          created_at = excluded.created_at,
          responded_at = NULL
      `).bind(inviteId, id, invitedUserId, c.get("userId"), role, now),
      c.env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(now, id),
    ]);

    const row = await c.env.DB.prepare(`
      SELECT
        gi.id,
        gi.group_id,
        g.name as group_name,
        g.description as group_description,
        gi.invited_user_id,
        invitee.name as invited_user_name,
        invitee.email as invited_user_email,
        invitee.avatar_url as invited_user_avatar_url,
        gi.invited_by_user_id,
        inviter.name as invited_by_name,
        inviter.email as invited_by_email,
        gi.role,
        gi.status,
        gi.created_at,
        gi.responded_at
      FROM group_invites gi
      JOIN groups g ON g.id = gi.group_id
      JOIN users invitee ON invitee.id = gi.invited_user_id
      JOIN users inviter ON inviter.id = gi.invited_by_user_id
      WHERE gi.group_id = ? AND gi.invited_user_id = ?
    `)
      .bind(id, invitedUserId)
      .first<GroupInviteRow>();

    if (row?.invited_user_email) {
      queueTask(c, sendGroupInviteNotification(c.env, {
        groupName: row.group_name,
        groupDescription: row.group_description ?? null,
        invitedName: row.invited_user_name ?? null,
        invitedEmail: row.invited_user_email,
        invitedByName: row.invited_by_name,
        role: row.role === "admin" ? "admin" : "member",
      }), `group-invite:${row.invited_user_email}`);
    }

    return c.json(toGroupInvite(row!), 201);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.post("/:id/join", async (c) => {
  const { id } = c.req.param();

  try {
    const invite = await c.env.DB.prepare(`
      SELECT id
      FROM group_invites
      WHERE group_id = ?
        AND invited_user_id = ?
        AND status = 'pending'
      LIMIT 1
    `)
      .bind(id, c.get("userId"))
      .first<{ id: string }>();
    if (!invite) return c.json({ error: "No pending invite found" }, 404);

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
        SELECT group_id, invited_user_id, role, ?
        FROM group_invites
        WHERE id = ?
      `).bind(now, invite.id),
      c.env.DB.prepare(`
        UPDATE group_invites
        SET status = 'accepted', responded_at = ?
        WHERE id = ?
      `).bind(now, invite.id),
      c.env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(now, id),
    ]);

    return c.json({ success: true, groupId: id });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.post("/invites/:inviteId/accept", async (c) => {
  const { inviteId } = c.req.param();

  try {
    const invite = await c.env.DB.prepare(`
      SELECT group_id, invited_user_id
      FROM group_invites
      WHERE id = ?
        AND invited_user_id = ?
        AND status = 'pending'
    `)
      .bind(inviteId, c.get("userId"))
      .first<{ group_id: string; invited_user_id: string }>();
    if (!invite) return c.json({ error: "Invite not found" }, 404);

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
        SELECT group_id, invited_user_id, role, ?
        FROM group_invites
        WHERE id = ?
      `).bind(now, inviteId),
      c.env.DB.prepare(`
        UPDATE group_invites
        SET status = 'accepted', responded_at = ?
        WHERE id = ?
      `).bind(now, inviteId),
      c.env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(now, invite.group_id),
    ]);

    return c.json({ success: true, groupId: invite.group_id });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.post("/invites/:inviteId/decline", async (c) => {
  const { inviteId } = c.req.param();

  try {
    const invite = await c.env.DB.prepare(`
      SELECT group_id
      FROM group_invites
      WHERE id = ?
        AND invited_user_id = ?
        AND status = 'pending'
    `)
      .bind(inviteId, c.get("userId"))
      .first<{ group_id: string }>();
    if (!invite) return c.json({ error: "Invite not found" }, 404);

    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      UPDATE group_invites
      SET status = 'declined', responded_at = ?
      WHERE id = ?
    `)
      .bind(now, inviteId)
      .run();

    return c.json({ success: true, groupId: invite.group_id });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.delete("/:id/invites/:inviteId", async (c) => {
  const { id, inviteId } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare(`
      DELETE FROM group_invites
      WHERE id = ?
        AND group_id = ?
        AND status = 'pending'
    `)
      .bind(inviteId, id)
      .run();

    return c.json({ success: true });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.delete("/:id/members/:userId", async (c) => {
  const { id, userId } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);
    if (userId === c.get("userId")) {
      return c.json({ error: "Cannot remove yourself from the group" }, 400);
    }

    const target = await c.env.DB.prepare(`
      SELECT role
      FROM group_members
      WHERE group_id = ? AND user_id = ?
    `)
      .bind(id, userId)
      .first<{ role: string }>();
    if (!target) return c.json({ error: "Not found" }, 404);

    if (target.role === "admin") {
      const adminCount = await c.env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM group_members
        WHERE group_id = ? AND role = 'admin'
      `)
        .bind(id)
        .first<{ count: number }>();
      if ((adminCount?.count ?? 0) <= 1) {
        return c.json({ error: "Cannot remove the last admin from the group" }, 400);
      }
    }

    await c.env.DB.batch([
      c.env.DB.prepare(`
        DELETE FROM payments
        WHERE member_id IN (
          SELECT m.id
          FROM members m
          WHERE m.user_id = ? AND m.group_id = ?
        )
      `).bind(userId, id),
      c.env.DB.prepare(`
        DELETE FROM session_members
        WHERE member_id IN (
          SELECT m.id
          FROM members m
          WHERE m.user_id = ? AND m.group_id = ?
        )
          AND session_id IN (SELECT id FROM sessions WHERE group_id = ?)
      `).bind(userId, id, id),
      c.env.DB.prepare("DELETE FROM members WHERE user_id = ? AND group_id = ?").bind(userId, id),
      c.env.DB.prepare("DELETE FROM group_invites WHERE group_id = ? AND invited_user_id = ?").bind(id, userId),
      c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").bind(id, userId),
      c.env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id),
    ]);

    return c.json({ success: true });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

// ─── Invite Link ─────────────────────────────────────────────

groups.post("/:id/invite-link", async (c) => {
  const { id } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    // Return existing active link if one exists
    const existing = await c.env.DB.prepare(`
      SELECT id, code, role, max_uses, use_count, expires_at, created_at
      FROM group_invite_links
      WHERE group_id = ?
        AND is_active = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC
      LIMIT 1
    `)
      .bind(id)
      .first<{ id: string; code: string; role: string; max_uses: number | null; use_count: number; expires_at: string | null; created_at: string }>();

    if (existing) {
      return c.json({
        code: existing.code,
        role: existing.role,
        maxUses: existing.max_uses,
        useCount: existing.use_count,
        expiresAt: existing.expires_at ?? undefined,
        createdAt: existing.created_at,
      });
    }

    // Create a new invite link
    const linkId = nanoid();
    const code = nanoid(10);
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO group_invite_links (id, group_id, code, created_by_user_id, role, is_active, created_at)
      VALUES (?, ?, ?, ?, 'member', 1, ?)
    `)
      .bind(linkId, id, code, c.get("userId"), now)
      .run();

    return c.json({
      code,
      role: "member",
      maxUses: null,
      useCount: 0,
      expiresAt: undefined,
      createdAt: now,
    }, 201);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run invite-link database migration first" }, 400);
    }
    throw error;
  }
});

groups.delete("/:id/invite-link", async (c) => {
  const { id } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare(`
      UPDATE group_invite_links
      SET is_active = 0
      WHERE group_id = ? AND is_active = 1
    `)
      .bind(id)
      .run();

    return c.json({ success: true });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run invite-link database migration first" }, 400);
    }
    throw error;
  }
});

groups.get("/join/:code", async (c) => {
  const { code } = c.req.param();

  try {
    const link = await c.env.DB.prepare(`
      SELECT gil.group_id, gil.role, g.name as group_name, g.description as group_description,
        (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = gil.group_id) as member_count
      FROM group_invite_links gil
      JOIN groups g ON g.id = gil.group_id
      WHERE gil.code = ?
        AND gil.is_active = 1
        AND (gil.expires_at IS NULL OR gil.expires_at > datetime('now'))
        AND (gil.max_uses IS NULL OR gil.use_count < gil.max_uses)
    `)
      .bind(code)
      .first<{ group_id: string; role: string; group_name: string; group_description: string | null; member_count: number }>();

    if (!link) return c.json({ error: "Invite link is invalid or expired" }, 404);

    // Check if user is already a member
    const existingMember = await c.env.DB.prepare(`
      SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?
    `)
      .bind(link.group_id, c.get("userId"))
      .first<{ user_id: string }>();

    return c.json({
      groupId: link.group_id,
      groupName: link.group_name,
      groupDescription: link.group_description ?? undefined,
      role: link.role,
      memberCount: link.member_count,
      alreadyMember: !!existingMember,
    });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run invite-link database migration first" }, 400);
    }
    throw error;
  }
});

groups.post("/join/:code", async (c) => {
  const { code } = c.req.param();

  try {
    const link = await c.env.DB.prepare(`
      SELECT id, group_id, role
      FROM group_invite_links
      WHERE code = ?
        AND is_active = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
        AND (max_uses IS NULL OR use_count < max_uses)
    `)
      .bind(code)
      .first<{ id: string; group_id: string; role: string }>();

    if (!link) return c.json({ error: "Invite link is invalid or expired" }, 404);

    // Check if already a member
    const existingMember = await c.env.DB.prepare(`
      SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?
    `)
      .bind(link.group_id, c.get("userId"))
      .first<{ user_id: string }>();

    if (existingMember) {
      return c.json({ success: true, groupId: link.group_id, alreadyMember: true });
    }

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(link.group_id, c.get("userId"), link.role, now),
      c.env.DB.prepare(`
        UPDATE group_invite_links SET use_count = use_count + 1 WHERE id = ?
      `).bind(link.id),
      c.env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(now, link.group_id),
    ]);

    return c.json({ success: true, groupId: link.group_id, alreadyMember: false });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run invite-link database migration first" }, 400);
    }
    throw error;
  }
});

export default groups;
