import { Hono } from "hono";
import { sendNewSessionNotification, sendPaymentDueNotification } from "../email";
import { Env } from "../types";
import { nanoid } from "../utils";

const sessions = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

type SessionBody = {
  date?: string;
  startTime?: string;
  start_time?: string;
  groupId?: string;
  group_id?: string;
  venue?: string;
  location?: string;
  note?: string;
  status?: string;
  paymentRecipient?: string | null;
  payment_recipient?: string | null;
};

type SessionRow = {
  id: string;
  group_id?: string | null;
  created_by?: string | null;
  status: string;
  [key: string]: unknown;
};

type CostRow = {
  id: string;
  amount: number;
  payer_id: string | null;
  consumer_id: string | null;
};

type CostBody = {
  label: string;
  amount: number;
  type?: string;
  payerId?: string | null;
  consumerId?: string | null;
  payer_id?: string | null;
  consumer_id?: string | null;
};

type GroupSessionNotificationRow = {
  group_name: string;
  creator_name?: string | null;
  recipient_email?: string | null;
};

type PaymentNotificationRow = {
  debtor_email?: string | null;
  debtor_name: string;
  recipient_name?: string | null;
  amount_owed: number;
};

function normalizePaymentRecipient(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("auto_") ? value.slice(5) : value;
}

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

function colorForUser(userId: string) {
  const total = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return MEMBER_COLORS[total % MEMBER_COLORS.length];
}

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id") ||
    message.includes("no such column: created_by")
  );
}

async function isGroupMember(c: any, groupId: string) {
  const row = await c.env.DB.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;
  return Boolean(row);
}

async function isGroupAdmin(c: any, groupId?: string | null) {
  if (!groupId) return false;
  const row = await c.env.DB.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;
  return row?.role === "admin";
}

async function canAccessSession(c: any, session: SessionRow) {
  if (!session.group_id) return true;
  if (c.get("userRole") === "admin") return true;
  return isGroupMember(c, session.group_id);
}

async function canManageSession(c: any, session: SessionRow) {
  if (c.get("userRole") === "admin") return true;

  const userId = c.get("userId");
  if (session.created_by && session.created_by === userId) {
    if (!session.group_id) return true;
    return isGroupMember(c, session.group_id);
  }

  const managersRaw = (session as any).managers;
  if (managersRaw) {
    try {
      const managers: string[] = JSON.parse(managersRaw);
      if (managers.includes(userId)) return true;
    } catch {
      // ignore bad legacy data
    }
  }

  return isGroupAdmin(c, session.group_id);
}

async function blockIfSessionHasConfirmedPayments(c: any, sessionId: string) {
  const confirmed = await c.env.DB.prepare(`
    SELECT id
    FROM payments
    WHERE session_id = ?
      AND (paid = 1 OR payer_marked_paid = 1)
    LIMIT 1
  `)
    .bind(sessionId)
    .first() as { id: string } | null;

  if (!confirmed) return null;

  return c.json({
    error: "This session has confirmed payments and money-related records are locked",
  }, 409);
}

sessions.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
  const joinedOnly = c.req.query("joined") === "true";

  if (joinedOnly) {
    try {
      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm2 WHERE sm2.session_id = s.id AND sm2.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        JOIN session_members sm ON sm.session_id = s.id
        JOIN members m ON m.id = sm.member_id
        WHERE m.user_id = ?
          AND sm.attended = 1
          ${groupId ? "AND s.group_id = ?" : ""}
        ORDER BY s.date DESC, s.start_time DESC
      `)
        .bind(...(groupId ? [c.get("userId"), groupId] : [c.get("userId")]))
        .all();
      return c.json(rows.results);
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;
      return c.json([]);
    }
  }

  if (groupId) {
    try {
      if (!(await isGroupMember(c, groupId)) && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        WHERE s.group_id = ?
        ORDER BY s.date DESC, s.start_time DESC
      `)
        .bind(groupId)
        .all();
      return c.json(rows.results);
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;
    }
  }

  try {
    if (c.get("userRole") === "admin") {
      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        ORDER BY s.date DESC, s.start_time DESC
      `).all();
      return c.json(rows.results);
    }

    const rows = await c.env.DB.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
        (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
      FROM sessions s
      WHERE s.group_id IS NULL
         OR EXISTS (
           SELECT 1
           FROM group_members gm
           WHERE gm.group_id = s.group_id
             AND gm.user_id = ?
         )
      ORDER BY s.date DESC, s.start_time DESC
    `)
      .bind(c.get("userId"))
      .all();
    return c.json(rows.results);
  } catch (error) {
    if (!isMissingGroupSchema(error)) throw error;
  }

  const rows = await c.env.DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
      (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
    FROM sessions s
    ORDER BY s.date DESC, s.start_time DESC
  `).all();
  return c.json(rows.results);
});

sessions.post("/", async (c) => {
  const body = await c.req.json<SessionBody>();
  const startTime = body.startTime ?? body.start_time;
  const groupId = body.groupId ?? body.group_id;
  const venue = body.venue?.trim();

  if (!body.date || !startTime || !venue) {
    return c.json({ error: "date, startTime, venue required" }, 400);
  }

  const id = nanoid();
  const now = new Date().toISOString();
  let notifyGroupId: string | null = null;

  if (groupId) {
    try {
      if (!(await isGroupMember(c, groupId)) && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      await c.env.DB.prepare(`
        INSERT INTO sessions (id, group_id, created_by, date, start_time, venue, location, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?)
      `)
        .bind(id, groupId, c.get("userId"), body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
      notifyGroupId = groupId;
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;

      await c.env.DB.prepare(`
        INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)
      `)
        .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
    }
  } else {
    await c.env.DB.prepare(`
      INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)
    `)
      .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();

  if (notifyGroupId) {
    const notificationRows = await c.env.DB.prepare(`
      SELECT
        g.name AS group_name,
        creator.name AS creator_name,
        recipient.email AS recipient_email
      FROM groups g
      LEFT JOIN users creator ON creator.id = ?
      JOIN group_members gm ON gm.group_id = g.id
      JOIN users recipient ON recipient.id = gm.user_id
      WHERE g.id = ?
        AND recipient.id <> ?
    `)
      .bind(c.get("userId"), notifyGroupId, c.get("userId"))
      .all<GroupSessionNotificationRow>();

    const recipients = notificationRows.results
      .map((item) => item.recipient_email?.trim())
      .filter((value): value is string => Boolean(value));

    if (recipients.length > 0) {
      const groupName = notificationRows.results[0]?.group_name ?? "Nhóm cầu lông";
      const creatorName = notificationRows.results[0]?.creator_name?.trim() || "Một thành viên";
      queueTask(c, sendNewSessionNotification(c.env, {
        groupName,
        creatorName,
        venue,
        date: body.date,
        startTime,
        location: body.location ?? null,
        note: body.note ?? null,
        sessionId: id,
        recipients,
      }), "new-session");
    }
  }

  return c.json(row, 201);
});

sessions.get("/:id", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canAccessSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const members = await c.env.DB.prepare(`
    SELECT m.*, sm.attended,
      u.email AS user_email,
      u.bank_bin AS user_bank_bin,
      u.bank_account_number AS user_bank_account_number,
      u.bank_account_name AS user_bank_account_name
    FROM members m
    JOIN session_members sm ON sm.member_id = m.id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE sm.session_id = ?
  `)
    .bind(id)
    .all();

  const costs = await c.env.DB.prepare(
    "SELECT * FROM costs WHERE session_id = ? ORDER BY rowid ASC"
  ).bind(id).all();

  const payments = await c.env.DB.prepare(
    "SELECT * FROM payments WHERE session_id = ?"
  ).bind(id).all();

  return c.json({ ...session, members: members.results, costs: costs.results, payments: payments.results });
});

sessions.put("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, existing))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<SessionBody>();
  const startTime = body.startTime ?? body.start_time;
  const paymentRecipient = body.paymentRecipient ?? body.payment_recipient;
  const normalizedPaymentRecipient = paymentRecipient === undefined
    ? undefined
    : normalizePaymentRecipient(paymentRecipient);
  const paymentRecipientChanged = normalizedPaymentRecipient !== undefined
    && normalizedPaymentRecipient !== ((existing as any).payment_recipient ?? null);

  if (paymentRecipientChanged) {
    const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
    if (lockedResponse) return lockedResponse;
  }

  await c.env.DB.prepare(`
    UPDATE sessions
    SET date = ?, start_time = ?, venue = ?, location = ?, note = ?, status = ?, payment_recipient = ?
    WHERE id = ?
  `)
    .bind(
      body.date ?? existing.date,
      startTime ?? existing.start_time,
      body.venue?.trim() || existing.venue,
      body.location !== undefined ? body.location : existing.location,
      body.note !== undefined ? body.note : existing.note,
      body.status ?? existing.status,
      normalizedPaymentRecipient !== undefined ? normalizedPaymentRecipient : (existing as any).payment_recipient ?? null,
      id
    )
    .run();

  if (paymentRecipientChanged) {
    await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, existing))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

sessions.post("/:id/transfer", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ memberId: string }>();
  if (!body.memberId) return c.json({ error: "memberId required" }, 400);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(body.memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member) return c.json({ error: "Member not found" }, 404);
  if (!member.user_id) return c.json({ error: "Member is not linked to a user account" }, 400);

  await c.env.DB.prepare("UPDATE sessions SET created_by = ? WHERE id = ?")
    .bind(member.user_id, id)
    .run();

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.post("/:id/managers", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ memberId: string }>();
  if (!body.memberId) return c.json({ error: "memberId required" }, 400);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(body.memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member) return c.json({ error: "Member not found" }, 404);
  if (!member.user_id) return c.json({ error: "Member is not linked to a user account" }, 400);

  const managers: string[] = session.managers ? JSON.parse(session.managers as string) : [];
  if (!managers.includes(member.user_id)) {
    managers.push(member.user_id);
    await c.env.DB.prepare("UPDATE sessions SET managers = ? WHERE id = ?")
      .bind(JSON.stringify(managers), id)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id/managers/:memberId", async (c) => {
  const { id, memberId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member || !member.user_id) return c.json({ error: "Member invalid" }, 400);

  const managers: string[] = session.managers ? JSON.parse(session.managers as string) : [];
  const nextManagers = managers.filter((userId) => userId !== member.user_id);
  await c.env.DB.prepare("UPDATE sessions SET managers = ? WHERE id = ?")
    .bind(JSON.stringify(nextManagers), id)
    .run();

  return c.json({ success: true });
});

sessions.post("/:id/join", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(id)
    .first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (session.status !== "upcoming") return c.json({ error: "Session is not open for joining" }, 400);
  if (!(await canAccessSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; name: string; email: string }>();
  if (!user) return c.json({ error: "User not found" }, 404);

  let existingMember: { id: string; group_id?: string | null } | null = null;
  if (session.group_id) {
    existingMember = await c.env.DB.prepare(`
      SELECT id, group_id
      FROM members
      WHERE user_id = ?
        AND (group_id = ? OR group_id IS NULL)
      ORDER BY CASE WHEN group_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `)
      .bind(userId, session.group_id, session.group_id)
      .first<{ id: string; group_id?: string | null }>();
  } else {
    existingMember = await c.env.DB.prepare(`
      SELECT id, group_id
      FROM members
      WHERE user_id = ?
        AND group_id IS NULL
      LIMIT 1
    `)
      .bind(userId)
      .first<{ id: string; group_id?: string | null }>();
  }

  const memberId = existingMember?.id ?? nanoid();
  if (existingMember) {
  await c.env.DB.prepare(`
    UPDATE members
    SET name = ?, phone = ?, is_active = 1, group_id = COALESCE(group_id, ?)
    WHERE id = ?
  `)
      .bind(user.name || user.email, null, session.group_id ?? null, memberId)
      .run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `)
      .bind(memberId, session.group_id ?? null, userId, user.name || user.email, null, colorForUser(userId), new Date().toISOString())
      .run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
      .bind(id, memberId),
    c.env.DB.prepare("UPDATE session_members SET attended = 1 WHERE session_id = ? AND member_id = ?")
      .bind(id, memberId),
  ]);
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  return c.json({ success: true, memberId });
});

sessions.delete("/:id/join", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT status, group_id FROM sessions WHERE id = ?")
    .bind(id)
    .first<{ status: string; group_id?: string | null }>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (session.status !== "upcoming") return c.json({ error: "Session is not open for changes" }, 400);
  if (session.group_id && !(await canAccessSession(c, { ...session, id, status: session.status } as SessionRow))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const member = await c.env.DB.prepare(`
    SELECT m.id
    FROM members m
    WHERE m.user_id = ?
      AND (
        (? IS NULL AND m.group_id IS NULL)
        OR m.group_id = ?
      )
    ORDER BY CASE WHEN m.group_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `)
    .bind(c.get("userId"), session.group_id ?? null, session.group_id ?? null, session.group_id ?? null)
    .first<{ id: string }>()
    || await c.env.DB.prepare(`
      SELECT m.id
      FROM session_members sm
      JOIN members m ON m.id = sm.member_id
      WHERE sm.session_id = ?
        AND m.user_id = ?
      LIMIT 1
    `)
      .bind(id, c.get("userId"))
      .first<{ id: string }>();

  if (!member) return c.json({ success: true });

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM session_members WHERE session_id = ? AND member_id = ?")
      .bind(id, member.id),
  ]);
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  return c.json({ success: true });
});

sessions.post("/:id/members", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const body = await c.req.json<{ memberIds: string[] }>();
  await c.env.DB.prepare("DELETE FROM session_members WHERE session_id = ?").bind(id).run();

  if (body.memberIds?.length) {
    const stmts = body.memberIds.map((memberId) =>
      c.env.DB.prepare("INSERT INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
        .bind(id, memberId)
    );
    await c.env.DB.batch(stmts);
  }
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  return c.json({ success: true });
});

sessions.post("/:id/costs", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const body = await c.req.json<CostBody>();
  const label = body.label?.trim();
  const amount = Number(body.amount);
  if (!label || !Number.isFinite(amount) || amount <= 0) return c.json({ error: "label, positive amount required" }, 400);

  const costId = nanoid();
  const payerId = body.payerId ?? body.payer_id ?? null;
  const consumerId = body.consumerId ?? body.consumer_id ?? null;

  await c.env.DB.prepare(`
    INSERT INTO costs (id, session_id, label, amount, type, payer_id, consumer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(costId, id, label, amount, body.type ?? "other", payerId, consumerId)
    .run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row, 201);
});

sessions.put("/:id/costs/:costId", async (c) => {
  const { id, costId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const existing = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ? AND session_id = ?")
    .bind(costId, id)
    .first<CostRow & { label: string; type: string }>();
  if (!existing) return c.json({ error: "Cost not found" }, 404);

  const body = await c.req.json<CostBody>();
  const label = body.label?.trim();
  const amount = Number(body.amount);
  if (!label || !Number.isFinite(amount) || amount <= 0) return c.json({ error: "label, positive amount required" }, 400);

  const payerId = body.payerId ?? body.payer_id ?? null;
  const consumerId = body.consumerId ?? body.consumer_id ?? null;

  await c.env.DB.prepare(`
    UPDATE costs
    SET label = ?, amount = ?, type = ?, payer_id = ?, consumer_id = ?
    WHERE id = ? AND session_id = ?
  `)
    .bind(label, amount, body.type ?? existing.type, payerId, consumerId, costId, id)
    .run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row);
});

sessions.delete("/:id/costs/:costId", async (c) => {
  const { id, costId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;
  await c.env.DB.prepare("DELETE FROM costs WHERE id = ?").bind(costId).run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();
  return c.json({ success: true });
});

sessions.post("/:id/recalculate", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;

  const attendees = await c.env.DB.prepare(
    "SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1"
  ).bind(id).all<{ member_id: string }>();
  const eligibleMembers = session.group_id
    ? await c.env.DB.prepare("SELECT id FROM members WHERE group_id = ?")
      .bind(session.group_id)
      .all<{ id: string }>()
    : await c.env.DB.prepare("SELECT id FROM members")
      .all<{ id: string }>();

  const count = attendees.results.length;
  if (count === 0) return c.json({ error: "No attendees" }, 400);

  const attendeeIds = attendees.results.map((item) => item.member_id);
  const attendeeSet = new Set(attendeeIds);
  const eligibleMemberSet = new Set(eligibleMembers.results.map((item) => item.id));
  const costs = await c.env.DB.prepare(
    "SELECT id, amount, payer_id, consumer_id FROM costs WHERE session_id = ?"
  ).bind(id).all<CostRow>();

  const sharedCosts = costs.results.filter((cost) => cost.consumer_id === null);
  const directCosts = costs.results.filter((cost) => cost.consumer_id !== null);
  const fallbackRecipientId = normalizePaymentRecipient((session as any).payment_recipient as string | null | undefined);

  if (fallbackRecipientId && !eligibleMemberSet.has(fallbackRecipientId)) {
    return c.json({ error: "Payment recipient must be an existing member" }, 400);
  }

  const paymentMap = new Map<string, number>();
  const addPayment = (memberId: string | null | undefined, recipientMemberId: string | null | undefined, amount: number) => {
    if (!memberId || !recipientMemberId || memberId === recipientMemberId || amount <= 0) return;
    const key = `${memberId}:${recipientMemberId}`;
    paymentMap.set(key, (paymentMap.get(key) ?? 0) + amount);
  };

  for (const cost of sharedCosts) {
    const recipientId = cost.payer_id ?? fallbackRecipientId;
    if (!recipientId) {
      return c.json({ error: "Shared costs need a payer or a common payment recipient" }, 400);
    }
    if (!eligibleMemberSet.has(recipientId)) {
      return c.json({ error: "Payment recipient must be an existing member" }, 400);
    }

    const roundedAmount = Math.round(cost.amount);
    const baseShare = Math.floor(roundedAmount / count);
    let remainder = roundedAmount - baseShare * count;

    for (const attendeeId of attendeeIds) {
      const share = baseShare + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      addPayment(attendeeId, recipientId, share);
    }
  }

  for (const cost of directCosts) {
    if (!cost.payer_id || !cost.consumer_id) {
      return c.json({ error: "Direct costs need both payer and consumer" }, 400);
    }
    if (!eligibleMemberSet.has(cost.payer_id) || !eligibleMemberSet.has(cost.consumer_id)) {
      return c.json({ error: "Payer and consumer must both be existing members" }, 400);
    }
    addPayment(cost.consumer_id, cost.payer_id, Math.round(cost.amount));
  }

  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  const stmts = Array.from(paymentMap.entries()).map(([key, amountOwed]) => {
    const [memberId, recipientMemberId] = key.split(":");
    return c.env.DB.prepare(`
      INSERT INTO payments (id, session_id, member_id, recipient_member_id, amount_owed, paid)
      VALUES (?, ?, ?, ?, ?, 0)
    `).bind(nanoid(), id, memberId, recipientMemberId, amountOwed);
  });
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const payments = await c.env.DB.prepare("SELECT * FROM payments WHERE session_id = ?").bind(id).all();

  const paymentNotificationRows = await c.env.DB.prepare(`
    SELECT
      debtor_user.email AS debtor_email,
      debtor_member.name AS debtor_name,
      recipient_member.name AS recipient_name,
      p.amount_owed
    FROM payments p
    JOIN members debtor_member ON debtor_member.id = p.member_id
    LEFT JOIN users debtor_user ON debtor_user.id = debtor_member.user_id
    LEFT JOIN members recipient_member ON recipient_member.id = p.recipient_member_id
    WHERE p.session_id = ?
      AND p.amount_owed > 0
      AND debtor_user.email IS NOT NULL
  `)
    .bind(id)
    .all<PaymentNotificationRow>();

  if (paymentNotificationRows.results.length > 0) {
    const grouped = new Map<string, { debtorName: string; lines: { recipientName: string; amount: number }[] }>();

    for (const item of paymentNotificationRows.results) {
      const email = item.debtor_email?.trim();
      if (!email) continue;
      const existing = grouped.get(email) ?? { debtorName: item.debtor_name, lines: [] };
      existing.lines.push({
        recipientName: item.recipient_name?.trim() || "người nhận",
        amount: item.amount_owed,
      });
      grouped.set(email, existing);
    }

    for (const [debtorEmail, payload] of grouped.entries()) {
      queueTask(c, sendPaymentDueNotification(c.env, {
        debtorEmail,
        debtorName: payload.debtorName,
        venue: String((session as any).venue ?? ""),
        date: String((session as any).date ?? ""),
        startTime: String((session as any).start_time ?? ""),
        sessionId: id,
        lines: payload.lines,
      }), `payment-due:${debtorEmail}`);
    }
  }

  return c.json(payments.results);
});

export default sessions;
