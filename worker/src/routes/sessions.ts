import { Hono } from "hono";
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

function colorForUser(userId: string) {
  const total = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return MEMBER_COLORS[total % MEMBER_COLORS.length];
}

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table: groups") || message.includes("no such table: group_members") || message.includes("no such column: group_id") || message.includes("no such column: created_by");
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
  if (session.created_by && session.created_by === c.get("userId")) {
    if (!session.group_id) return true;
    return isGroupMember(c, session.group_id);
  }
  return isGroupAdmin(c, session.group_id);
}

sessions.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
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
      `).bind(groupId).all();
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
  if (!body.date || !startTime || !venue) return c.json({ error: "date, startTime, venue required" }, 400);
  const id = nanoid();
  const now = new Date().toISOString();

  if (groupId) {
    try {
      if (!(await isGroupMember(c, groupId)) && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }
      await c.env.DB.prepare(
        "INSERT INTO sessions (id, group_id, created_by, date, start_time, venue, location, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?)"
      )
        .bind(id, groupId, c.get("userId"), body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;
      await c.env.DB.prepare(
        "INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)"
      )
        .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
    }
  } else {
    await c.env.DB.prepare(
      "INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)"
    )
      .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
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
  `).bind(id).all();

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
  await c.env.DB.prepare(
    "UPDATE sessions SET date = ?, start_time = ?, venue = ?, location = ?, note = ?, status = ?, payment_recipient = ? WHERE id = ?"
  )
    .bind(
      body.date ?? existing.date,
      startTime ?? existing.start_time,
      body.venue?.trim() || existing.venue,
      body.location !== undefined ? body.location : existing.location,
      body.note !== undefined ? body.note : existing.note,
      body.status ?? existing.status,
      paymentRecipient !== undefined ? (paymentRecipient || null) : (existing as any).payment_recipient ?? null,
      id
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, existing))) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
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
    await c.env.DB.prepare(
      "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
    )
      .bind(memberId, session.group_id ?? null, userId, user.name || user.email, null, colorForUser(userId), new Date().toISOString())
      .run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
      .bind(id, memberId),
    c.env.DB.prepare("UPDATE session_members SET attended = 1 WHERE session_id = ? AND member_id = ?")
      .bind(id, memberId),
  ]);

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
    c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND member_id = ?")
      .bind(id, member.id),
  ]);

  return c.json({ success: true });
});

// Set check-in list (replace all)
sessions.post("/:id/members", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ memberIds: string[] }>();
  await c.env.DB.prepare("DELETE FROM session_members WHERE session_id = ?").bind(id).run();
  if (body.memberIds?.length) {
    const stmts = body.memberIds.map((mid: string) =>
      c.env.DB.prepare("INSERT INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
        .bind(id, mid)
    );
    await c.env.DB.batch(stmts);
  }
  return c.json({ success: true });
});

// Add cost
sessions.post("/:id/costs", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ label: string; amount: number; type?: string; payerId?: string | null; consumerId?: string | null; payer_id?: string | null; consumer_id?: string | null }>();
  if (!body.label || body.amount == null) return c.json({ error: "label, amount required" }, 400);
  const costId = nanoid();
  const payerId = body.payerId ?? body.payer_id ?? null;
  const consumerId = body.consumerId ?? body.consumer_id ?? null;
  await c.env.DB.prepare(
    "INSERT INTO costs (id, session_id, label, amount, type, payer_id, consumer_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(costId, id, body.label, body.amount, body.type ?? "other", payerId, consumerId)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row, 201);
});

// Delete cost
sessions.delete("/:id/costs/:costId", async (c) => {
  const { id, costId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM costs WHERE id = ?").bind(costId).run();
  return c.json({ success: true });
});

// Recalculate payments
sessions.post("/:id/recalculate", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const attendees = await c.env.DB.prepare(
    "SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1"
  ).bind(id).all<{ member_id: string }>();

  const count = attendees.results.length;
  if (count === 0) return c.json({ error: "No attendees" }, 400);

  type CostRow = { id: string; amount: number; payer_id: string | null; consumer_id: string | null };
  const costs = await c.env.DB.prepare(
    "SELECT id, amount, payer_id, consumer_id FROM costs WHERE session_id = ?"
  ).bind(id).all<CostRow>();

  // Tổng chi phí chung (consumer_id IS NULL) — chia đều cho tất cả attendees
  const sharedTotal = costs.results
    .filter((c) => c.consumer_id === null)
    .reduce((sum, c) => sum + c.amount, 0);
  const sharedPerPerson = sharedTotal / count;

  // Khởi tạo bảng tính cho từng attendee
  const amountMap = new Map<string, number>();
  for (const a of attendees.results) {
    amountMap.set(a.member_id, sharedPerPerson);
  }

  for (const cost of costs.results) {
    // Cộng chi phí cá nhân vào đúng người dùng
    if (cost.consumer_id !== null) {
      const current = amountMap.get(cost.consumer_id) ?? 0;
      amountMap.set(cost.consumer_id, current + cost.amount);
    }
    // Trừ tiền chi hộ khỏi người đã bỏ tiền ra
    if (cost.payer_id !== null) {
      const current = amountMap.get(cost.payer_id) ?? 0;
      amountMap.set(cost.payer_id, current - cost.amount);
    }
  }

  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  const stmts = attendees.results.map((a) => {
    const amountOwed = amountMap.get(a.member_id) ?? 0;
    return c.env.DB.prepare(
      "INSERT INTO payments (id, session_id, member_id, amount_owed, paid) VALUES (?, ?, ?, ?, 0)"
    ).bind(nanoid(), id, a.member_id, Math.ceil(amountOwed));
  });
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const payments = await c.env.DB.prepare("SELECT * FROM payments WHERE session_id = ?").bind(id).all();
  return c.json(payments.results);
});

export default sessions;
