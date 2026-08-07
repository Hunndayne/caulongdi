import { Hono } from "hono";
import { sendGroupInviteNotification } from "../email";
import { Env } from "../types";
import { nanoid } from "../utils";
import { ensureBotTables } from "../db/botTables";
import { ensureTimoPotTables } from "../db/timoTables";
import { normalizeAccountNumber } from "../paymentConfirm";
import {
  DEBT_REMINDER_CYCLES,
  DEBT_REMINDER_DEFAULT_INTERVAL_DAYS,
  DEBT_REMINDER_DEFAULT_TIME,
  DEBT_REMINDER_DEFAULT_WEEKDAY,
  DEBT_REMINDER_MAX_INTERVAL_DAYS,
  DEBT_REMINDER_MIN_INTERVAL_DAYS,
  DebtReminderColumns,
  isValidReminderTime,
  nextRunDate,
  normalizeIntervalDays,
  normalizeWeekday,
  readDebtReminder,
  vnDateString,
} from "../debtReminder";
import {
  TIMO_CODE,
  fetchAliasInfo,
  fetchTxnPage,
  flattenTxnPage,
  parseShareCode,
  pollGroupPot,
  sha512Hex,
  shareUrlFromCode,
  timoErrorMessage,
} from "../timoPot";

const BOT_LINK_CODE_TTL_MS = 10 * 60 * 1000;

function generateBotLinkCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

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
  // Chỉ những cột an toàn để mọi thành viên thấy. timo_security_hash KHÔNG map ra ngoài.
  group_bank_bin?: string | null;
  group_bank_account_number?: string | null;
  group_bank_account_name?: string | null;
  timo_verify_code?: string | null;
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

async function userHasConfirmedGroupPayments(c: any, groupId: string, userId: string) {
  const row = await c.env.DB.prepare(`
    SELECT p.id
    FROM payments p
    WHERE (p.paid = 1 OR p.payer_marked_paid = 1)
      AND (
        p.member_id IN (
          SELECT id FROM members WHERE group_id = ? AND user_id = ?
        )
        OR p.recipient_member_id IN (
          SELECT id FROM members WHERE group_id = ? AND user_id = ?
        )
      )
    LIMIT 1
  `)
    .bind(groupId, userId, groupId, userId)
    .first() as { id: string } | null;

  return Boolean(row);
}

async function groupHasConfirmedPayments(c: any, groupId: string) {
  const row = await c.env.DB.prepare(`
    SELECT p.id
    FROM payments p
    WHERE (p.paid = 1 OR p.payer_marked_paid = 1)
      AND (
        p.session_id IN (
          SELECT id FROM sessions WHERE group_id = ?
        )
        OR p.member_id IN (
          SELECT id FROM members WHERE group_id = ?
        )
        OR p.recipient_member_id IN (
          SELECT id FROM members WHERE group_id = ?
        )
      )
    LIMIT 1
  `)
    .bind(groupId, groupId, groupId)
    .first() as { id: string } | null;

  return Boolean(row);
}

async function tableExists(c: any, tableName: string) {
  const row = await c.env.DB.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `)
    .bind(tableName)
    .first() as { name: string } | null;

  return Boolean(row);
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
    // Tài khoản nhận tiền CHUNG của nhóm — khác hoàn toàn tài khoản cá nhân trong profile.
    // Trang buổi chơi dùng bộ này để dựng QR khi buổi đặt thu về nhóm.
    groupBankBin: row.group_bank_bin ?? null,
    groupBankAccountNumber: row.group_bank_account_number ?? null,
    groupBankAccountName: row.group_bank_account_name ?? null,
    // Có hũ Timo thì thanh toán thu về nhóm được tự xác nhận.
    timoEnabled: Boolean(row.timo_verify_code?.trim()),
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

groups.put("/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ name?: string; description?: string }>().catch(() => null);
  const name = body?.name?.trim().slice(0, 80);
  const description = body?.description?.trim().slice(0, 240) || null;
  if (!name) return c.json({ error: "name required" }, 400);

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    const result = await c.env.DB.prepare(
      "UPDATE groups SET name = ?, description = ?, updated_at = ? WHERE id = ?"
    )
      .bind(name, description, new Date().toISOString(), id)
      .run();
    if (!result.meta?.changes) return c.json({ error: "Group not found" }, 404);

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

    return c.json(toGroup(row!));
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

groups.delete("/:id", async (c) => {
  const { id } = c.req.param();

  try {
    const group = await c.env.DB.prepare(`
      SELECT id, owner_user_id
      FROM groups
      WHERE id = ?
    `)
      .bind(id)
      .first<{ id: string; owner_user_id: string }>();
    if (!group) return c.json({ error: "Group not found" }, 404);

    const userId = c.get("userId");
    if (c.get("userRole") !== "admin" && group.owner_user_id !== userId) {
      return c.json({ error: "Only the group owner can delete this group" }, 403);
    }

    if (await groupHasConfirmedPayments(c, id)) {
      return c.json({
        error: "This group has confirmed payments and cannot be deleted",
      }, 409);
    }

    const stmts = [
      c.env.DB.prepare(`
        DELETE FROM payments
        WHERE session_id IN (SELECT id FROM sessions WHERE group_id = ?)
          OR member_id IN (SELECT id FROM members WHERE group_id = ?)
          OR recipient_member_id IN (SELECT id FROM members WHERE group_id = ?)
      `).bind(id, id, id),
      c.env.DB.prepare(`
        DELETE FROM session_members
        WHERE session_id IN (SELECT id FROM sessions WHERE group_id = ?)
          OR member_id IN (SELECT id FROM members WHERE group_id = ?)
      `).bind(id, id),
      c.env.DB.prepare(`
        DELETE FROM costs
        WHERE session_id IN (SELECT id FROM sessions WHERE group_id = ?)
      `).bind(id),
      c.env.DB.prepare("DELETE FROM sessions WHERE group_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM members WHERE group_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM group_invites WHERE group_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
    ];

    if (await tableExists(c, "group_invite_links")) {
      stmts.splice(stmts.length - 1, 0, c.env.DB.prepare("DELETE FROM group_invite_links WHERE group_id = ?").bind(id));
    }

    await c.env.DB.batch(stmts);
    return c.json({ success: true });
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

    if (await userHasConfirmedGroupPayments(c, id, userId)) {
      return c.json({
        error: "This member has confirmed payments and cannot be removed from the group",
      }, 409);
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

// ─── Liên kết Messenger ──────────────────────────────────────
// Sinh mã OTP để admin nhóm gõ /connect <mã> trong group chat Facebook.

groups.post("/:id/bot-link-code", async (c) => {
  const { id } = c.req.param();

  try {
    const membership = await getMembership(c, id);
    if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

    await ensureBotTables(c.env.DB);

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + BOT_LINK_CODE_TTL_MS).toISOString();

    // Dọn mã hết hạn / đã dùng để bảng gọn và tránh đụng khoá chính.
    await c.env.DB.prepare(
      "DELETE FROM bot_link_codes WHERE expires_at < ? OR used_at IS NOT NULL"
    )
      .bind(createdAt)
      .run();

    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateBotLinkCode();
      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO bot_link_codes (code, group_id, issued_by, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      )
        .bind(candidate, id, c.get("userId"), expiresAt, createdAt)
        .run();
      if (result.meta?.changes) {
        code = candidate;
        break;
      }
    }
    if (!code) return c.json({ error: "Could not generate code, try again" }, 500);

    return c.json({ code, expiresAt, ttlSeconds: Math.floor(BOT_LINK_CODE_TTL_MS / 1000) });
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      return c.json({ error: "Run group database migration first" }, 400);
    }
    throw error;
  }
});

// ─── Cài đặt thanh toán của nhóm ─────────────────────────────
// Tài khoản nhận tiền CHUNG của nhóm (trưởng nhóm điền) + hũ Timo TUỲ CHỌN để tự xác nhận.
// Tài khoản chung này KHÁC HOÀN TOÀN tài khoản cá nhân trong profile: cá nhân dùng cho
// chiều hoàn tiền lại người ứng chi phí, tài khoản chung dùng cho chiều thu tiền của nhóm.

const TIMO_CHECK_THROTTLE_MS = 15_000;

type PaymentSettingsRow = {
  id: string;
  group_bank_bin?: string | null;
  group_bank_account_number?: string | null;
  group_bank_account_name?: string | null;
  timo_verify_code?: string | null;
  timo_security_hash?: string | null;
  timo_pot_name?: string | null;
  timo_pot_account?: string | null;
  timo_pot_alt_account?: string | null;
  timo_pot_bank_label?: string | null;
  timo_owner_name?: string | null;
  timo_last_checked_at?: string | null;
  timo_last_ok_at?: string | null;
  timo_last_error?: string | null;
};

async function loadPaymentSettings(c: any, groupId: string): Promise<PaymentSettingsRow | null> {
  const row = await c.env.DB.prepare(`
    SELECT id, group_bank_bin, group_bank_account_number, group_bank_account_name,
           timo_verify_code, timo_security_hash, timo_pot_name, timo_pot_account,
           timo_pot_alt_account, timo_pot_bank_label, timo_owner_name,
           timo_last_checked_at, timo_last_ok_at, timo_last_error
    FROM groups
    WHERE id = ?
  `)
    .bind(groupId)
    .first();

  return (row as PaymentSettingsRow | null) ?? null;
}

// KHÔNG bao giờ trả timo_security_hash ra ngoài: với API Timo, hash chính là mật khẩu.
function toPaymentSettings(row: PaymentSettingsRow | null, recentTxns: unknown[] = []) {
  const verifyCode = row?.timo_verify_code?.trim() || null;
  const account = normalizeAccountNumber(row?.group_bank_account_number);
  const potAccount = normalizeAccountNumber(row?.timo_pot_account);

  return {
    bankBin: row?.group_bank_bin ?? null,
    bankAccountNumber: row?.group_bank_account_number ?? null,
    bankAccountName: row?.group_bank_account_name ?? null,
    configured: Boolean(row?.group_bank_bin && row?.group_bank_account_number),
    timo: {
      configured: Boolean(verifyCode),
      verifyCode,
      shareUrl: verifyCode ? shareUrlFromCode(verifyCode) : null,
      hasSecurityCode: Boolean(row?.timo_security_hash),
      potName: row?.timo_pot_name ?? null,
      potAccount: row?.timo_pot_account ?? null,
      potAltAccount: row?.timo_pot_alt_account ?? null,
      potBankLabel: row?.timo_pot_bank_label ?? null,
      ownerName: row?.timo_owner_name ?? null,
      // Cảnh báo cái bẫy chí tử: điền tài khoản chính thay vì tài khoản riêng của hũ thì
      // tiền không vào hũ, lịch sử hũ không thấy gì và không bao giờ tự xác nhận được.
      accountMatchesPot: verifyCode && account && potAccount ? account === potAccount : null,
      lastCheckedAt: row?.timo_last_checked_at ?? null,
      lastOkAt: row?.timo_last_ok_at ?? null,
      lastError: row?.timo_last_error ?? null,
      recentTxns,
    },
  };
}

type TimoSeenTxnRow = {
  txn_date: string | null;
  amount: number | null;
  txn_title: string | null;
  txn_desc: string | null;
  payment_id: string | null;
  outcome: string;
  seen_at: string;
};

async function recentTimoTxns(c: any, groupId: string) {
  const rows = await c.env.DB.prepare(`
    SELECT txn_date, amount, txn_title, txn_desc, payment_id, outcome, seen_at
    FROM timo_seen_txn
    WHERE group_id = ?
    ORDER BY seen_at DESC
    LIMIT 10
  `)
    .bind(groupId)
    .all();

  return ((rows.results ?? []) as TimoSeenTxnRow[]).map((row) => ({
    date: row.txn_date,
    amount: row.amount,
    title: row.txn_title,
    description: row.txn_desc,
    paymentId: row.payment_id,
    outcome: row.outcome,
    seenAt: row.seen_at,
  }));
}

groups.get("/:id/payment-settings", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  await ensureTimoPotTables(c.env.DB);

  const row = await loadPaymentSettings(c, id);
  if (!row) return c.json({ error: "Group not found" }, 404);

  return c.json(toPaymentSettings(row, await recentTimoTxns(c, id)));
});

groups.put("/:id/payment-settings", async (c) => {
  const { id } = c.req.param();
  const body = await c.req
    .json<{
      bankBin?: string;
      bankAccountNumber?: string;
      bankAccountName?: string;
      shareUrl?: string;
      passcode?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  await ensureTimoPotTables(c.env.DB);
  const existing = await loadPaymentSettings(c, id);
  if (!existing) return c.json({ error: "Group not found" }, 404);

  // ── Tài khoản chung của nhóm ──
  const bankBin = body.bankBin?.trim() ?? "";
  const bankAccountNumber = body.bankAccountNumber?.trim() ?? "";
  const bankAccountName = body.bankAccountName?.trim() ?? "";

  if (bankBin && !/^\d{6}$/.test(bankBin)) {
    return c.json({ error: "Mã ngân hàng (BIN) phải là 6 chữ số" }, 400);
  }
  // Số tài khoản hũ Timo có dạng chữ+số (vd TIMO90C0908A658) nên không ép chỉ chữ số.
  if (bankAccountNumber && !/^[A-Za-z0-9]{4,32}$/.test(bankAccountNumber)) {
    return c.json({ error: "Số tài khoản chỉ gồm chữ và số, 4-32 ký tự" }, 400);
  }
  if (bankAccountNumber && !bankBin) {
    return c.json({ error: "Chọn ngân hàng cho số tài khoản của nhóm" }, 400);
  }

  // ── Hũ Timo (không bắt buộc) ──
  const rawShare = body.shareUrl?.trim() ?? "";
  const passcode = body.passcode?.trim() ?? "";
  const clearTimo = body.shareUrl !== undefined && rawShare === "";

  let verifyCode = existing.timo_verify_code?.trim() || null;
  let securityHash = existing.timo_security_hash ?? null;
  let potInfo: {
    name: string | null;
    account: string | null;
    altAccount: string | null;
    bankLabel: string | null;
    owner: string | null;
  } | null = null;
  let warning: string | null = null;
  let txnCount: number | null = null;

  if (clearTimo) {
    verifyCode = null;
    securityHash = null;
  } else if (rawShare) {
    const parsed = parseShareCode(rawShare);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(parsed)) {
      return c.json({ error: "Link chia sẻ hũ không đúng định dạng" }, 400);
    }

    // Mật khẩu mới thì hash lại; giữ mật khẩu cũ nếu link không đổi và không nhập gì.
    if (passcode) securityHash = await sha512Hex(passcode);
    else if (parsed !== verifyCode) securityHash = null;
    verifyCode = parsed;

    // Xác minh thật với Timo ngay lúc lưu — sai thì báo luôn, đừng để cron lỗi âm thầm.
    let aliasInfo;
    let txnProbe;
    try {
      aliasInfo = await fetchAliasInfo(verifyCode, securityHash);
      if (aliasInfo.code === TIMO_CODE.SUCCESS) {
        txnProbe = await fetchTxnPage({
          hashVerifyCode: await sha512Hex(verifyCode),
          securityHash,
        });
      }
    } catch (error) {
      console.error("[payment-settings] gọi Timo lỗi", error);
      return c.json({ error: "Không gọi được Timo, thử lại sau" }, 502);
    }

    if (aliasInfo.code !== TIMO_CODE.SUCCESS) {
      return c.json({ error: timoErrorMessage(aliasInfo.code ?? 0) }, 400);
    }
    if (txnProbe && txnProbe.code !== TIMO_CODE.SUCCESS) {
      return c.json({ error: timoErrorMessage(txnProbe.code ?? 0) }, 400);
    }

    const info = aliasInfo.data ?? {};
    potInfo = {
      name: info.sourceMoney ?? null,
      account: info.accountNumber ?? null,
      altAccount: info.altAccountNumber ?? null,
      bankLabel: info.bankNameDomestic ?? info.bankName ?? info.bankShortName ?? null,
      owner: info.fullName ?? null,
    };
    txnCount = flattenTxnPage(txnProbe?.data).length;

    const effectiveAccount = normalizeAccountNumber(
      bankAccountNumber || existing.group_bank_account_number
    );
    const potAccount = normalizeAccountNumber(potInfo.account);
    if (effectiveAccount && potAccount && effectiveAccount !== potAccount) {
      warning =
        `Số tài khoản của nhóm (${effectiveAccount}) không phải số tài khoản riêng của hũ ` +
        `(${potInfo.account}). Tiền sẽ không vào hũ nên không tự xác nhận được — ` +
        `sửa lại số tài khoản của nhóm thành số của hũ.`;
    }
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(`
    UPDATE groups
    SET group_bank_bin = ?,
        group_bank_account_number = ?,
        group_bank_account_name = ?,
        updated_at = ?
    WHERE id = ?
  `)
    .bind(bankBin || null, bankAccountNumber || null, bankAccountName || null, now, id)
    .run();

  if (clearTimo) {
    await c.env.DB.batch([
      c.env.DB.prepare(`
        UPDATE groups
        SET timo_verify_code = NULL, timo_security_hash = NULL, timo_pot_name = NULL,
            timo_pot_account = NULL, timo_pot_alt_account = NULL, timo_pot_bank_label = NULL,
            timo_owner_name = NULL, timo_last_checked_at = NULL, timo_last_ok_at = NULL,
            timo_last_error = NULL
        WHERE id = ?
      `).bind(id),
      c.env.DB.prepare("DELETE FROM timo_seen_txn WHERE group_id = ?").bind(id),
    ]);
  } else if (potInfo) {
    await c.env.DB.prepare(`
      UPDATE groups
      SET timo_verify_code = ?, timo_security_hash = ?, timo_pot_name = ?, timo_pot_account = ?,
          timo_pot_alt_account = ?, timo_pot_bank_label = ?, timo_owner_name = ?,
          timo_last_checked_at = ?, timo_last_ok_at = ?, timo_last_error = NULL
      WHERE id = ?
    `)
      .bind(
        verifyCode,
        securityHash,
        potInfo.name,
        potInfo.account,
        potInfo.altAccount,
        potInfo.bankLabel,
        potInfo.owner,
        now,
        now,
        id
      )
      .run();
  }

  const saved = await loadPaymentSettings(c, id);
  return c.json({
    ...toPaymentSettings(saved, await recentTimoTxns(c, id)),
    warning,
    txnCount,
  });
});

// "Kiểm tra ngay" — người trả bấm sau khi chuyển khoản, khỏi chờ hết nhịp cron 10 phút.
// Mở cho mọi thành viên nhóm, chặn spam bằng mốc thời gian lần quét trước.
groups.post("/:id/payment-settings/check", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  await ensureTimoPotTables(c.env.DB);

  const row = await loadPaymentSettings(c, id);
  if (!row) return c.json({ error: "Group not found" }, 404);
  if (!row.timo_verify_code?.trim()) {
    return c.json({ error: "Nhóm chưa cấu hình link hũ Timo" }, 400);
  }

  const lastChecked = row.timo_last_checked_at ? Date.parse(row.timo_last_checked_at) : 0;
  if (lastChecked && Date.now() - lastChecked < TIMO_CHECK_THROTTLE_MS) {
    return c.json({ throttled: true, lastCheckedAt: row.timo_last_checked_at });
  }

  const summary = await pollGroupPot(c.env, row, {
    defer: (task) => c.executionCtx?.waitUntil?.(task),
  });

  return c.json({ throttled: false, ...summary });
});

// ─── Nhắc công nợ định kỳ qua group chat Messenger ─────────────
// Cron 10'/lần trong botOutbox.ts đọc các cột debt_reminder_*; nhóm chưa liên kết thread thì
// enqueueBotMessage tự bỏ qua nên không cần chặn ở đây.
// Luật chu kỳ (daily / every_n_days / weekly / monthly_end) nằm trong ../debtReminder.ts,
// dùng chung với cron để hai bên không hiểu khác nhau.

type DebtReminderRow = DebtReminderColumns & { thread_id?: string | null };

const DEBT_REMINDER_SELECT = `SELECT g.debt_reminder_enabled, g.debt_reminder_time, g.debt_reminder_cycle,
    g.debt_reminder_interval_days, g.debt_reminder_weekday, g.debt_reminder_anchor_date, l.thread_id
   FROM groups g
   LEFT JOIN bot_thread_links l ON l.group_id = g.id
   WHERE g.id = ?`;

/** Giờ VN — cùng quy ước với cron trong botOutbox.ts. */
function vnNowDate() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function toDebtReminder(row: DebtReminderRow) {
  const config = readDebtReminder(row);
  return {
    ...config,
    // Kỳ kế tiếp để UI nói rõ "cách N ngày" là tính từ đâu; tắt thì hiển thị cũng vô nghĩa.
    nextRunDate: config.enabled ? nextRunDate(config, vnNowDate()) : "",
    // Bật mà chưa liên kết Messenger thì chẳng có nơi nào nhận tin — UI cảnh báo dựa vào cờ này.
    messengerLinked: Boolean(row.thread_id),
  };
}

groups.get("/:id/debt-reminder", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  await ensureBotTables(c.env.DB);

  const row = await c.env.DB.prepare(DEBT_REMINDER_SELECT).bind(id).first<DebtReminderRow>();
  if (!row) return c.json({ error: "Group not found" }, 404);

  return c.json(toDebtReminder(row));
});

groups.put("/:id/debt-reminder", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  const body = await c.req
    .json<{ enabled?: boolean; time?: string; cycle?: string; intervalDays?: number; weekday?: number }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const time = (body.time ?? "").trim() || DEBT_REMINDER_DEFAULT_TIME;
  if (!isValidReminderTime(time)) {
    return c.json({ error: 'Giờ nhắc phải theo dạng "HH:MM", ví dụ 20:00' }, 400);
  }

  // Không dùng normalize* cho input: gõ sai thì báo lỗi rõ, im lặng đổi sang mặc định dễ gây hiểu nhầm.
  const cycle = (body.cycle ?? "").trim() || "daily";
  if (!(DEBT_REMINDER_CYCLES as string[]).includes(cycle)) {
    return c.json({ error: `Chu kỳ nhắc phải là một trong: ${DEBT_REMINDER_CYCLES.join(", ")}` }, 400);
  }

  const rawInterval = Math.trunc(Number(body.intervalDays ?? DEBT_REMINDER_DEFAULT_INTERVAL_DAYS));
  if (
    cycle === "every_n_days" &&
    (!Number.isFinite(rawInterval) ||
      rawInterval < DEBT_REMINDER_MIN_INTERVAL_DAYS ||
      rawInterval > DEBT_REMINDER_MAX_INTERVAL_DAYS)
  ) {
    return c.json(
      {
        error: `Số ngày giữa hai lần nhắc phải từ ${DEBT_REMINDER_MIN_INTERVAL_DAYS} đến ${DEBT_REMINDER_MAX_INTERVAL_DAYS}`,
      },
      400
    );
  }

  const rawWeekday = Math.trunc(Number(body.weekday ?? DEBT_REMINDER_DEFAULT_WEEKDAY));
  if (cycle === "weekly" && (!Number.isFinite(rawWeekday) || rawWeekday < 0 || rawWeekday > 6)) {
    return c.json({ error: "Thứ trong tuần phải từ 0 (Chủ nhật) đến 6 (Thứ 7)" }, 400);
  }

  // Chu kỳ đang chọn không dùng tới hai giá trị này thì client gửi gì cũng kệ — nhưng vẫn phải
  // ghi số hợp lệ, không để NaN rơi xuống cột.
  const intervalDays = normalizeIntervalDays(rawInterval);
  const weekday = normalizeWeekday(rawWeekday);

  await ensureBotTables(c.env.DB);

  const before = await c.env.DB.prepare(DEBT_REMINDER_SELECT).bind(id).first<DebtReminderRow>();
  if (!before) return c.json({ error: "Group not found" }, 404);

  // Mốc chỉ reset khi nhịp thật sự đổi — sửa mỗi giờ nhắc thì "cách N ngày" không bị nhảy kỳ.
  const previous = readDebtReminder(before);
  const keepAnchor =
    previous.anchorDate && previous.cycle === cycle && previous.intervalDays === intervalDays;
  const anchorDate = keepAnchor ? (previous.anchorDate as string) : vnDateString(vnNowDate());

  await c.env.DB.prepare(
    `UPDATE groups SET debt_reminder_enabled = ?, debt_reminder_time = ?, debt_reminder_cycle = ?,
      debt_reminder_interval_days = ?, debt_reminder_weekday = ?, debt_reminder_anchor_date = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      body.enabled ? 1 : 0,
      time,
      cycle,
      intervalDays,
      weekday,
      anchorDate,
      new Date().toISOString(),
      id
    )
    .run();

  return c.json(
    toDebtReminder({
      thread_id: before.thread_id,
      debt_reminder_enabled: body.enabled ? 1 : 0,
      debt_reminder_time: time,
      debt_reminder_cycle: cycle,
      debt_reminder_interval_days: intervalDays,
      debt_reminder_weekday: weekday,
      debt_reminder_anchor_date: anchorDate,
    })
  );
});

// Chatbot chạy bằng AI agent (tool-calling) — bật/tắt theo từng nhóm. Chỉ admin nhóm.
groups.get("/:id/bot-agent", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  await ensureBotTables(c.env.DB);

  const row = await c.env.DB.prepare("SELECT bot_agent_enabled FROM groups WHERE id = ?")
    .bind(id)
    .first<{ bot_agent_enabled?: number | null }>();
  if (!row) return c.json({ error: "Group not found" }, 404);

  return c.json({ enabled: Boolean(row.bot_agent_enabled) });
});

groups.put("/:id/bot-agent", async (c) => {
  const { id } = c.req.param();

  const membership = await getMembership(c, id);
  if (membership !== "admin") return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  await ensureBotTables(c.env.DB);

  const result = await c.env.DB.prepare(
    "UPDATE groups SET bot_agent_enabled = ?, updated_at = ? WHERE id = ?"
  )
    .bind(body.enabled ? 1 : 0, new Date().toISOString(), id)
    .run();
  if (!result.meta?.changes) return c.json({ error: "Group not found" }, 404);

  return c.json({ enabled: Boolean(body.enabled) });
});

export default groups;
