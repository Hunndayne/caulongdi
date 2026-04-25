import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";

const sessions = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

sessions.get("/", async (c) => {
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
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ date: string; startTime: string; venue: string; location?: string; note?: string }>();
  if (!body.date || !body.startTime || !body.venue) return c.json({ error: "date, startTime, venue required" }, 400);
  const id = nanoid();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)"
  )
    .bind(id, body.date, body.startTime, body.venue, body.location ?? null, body.note ?? null, now)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row, 201);
});

sessions.get("/:id", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  if (!session) return c.json({ error: "Not found" }, 404);

  const members = await c.env.DB.prepare(`
    SELECT m.*, sm.attended FROM members m
    JOIN session_members sm ON sm.member_id = m.id
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
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first() as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ date?: string; startTime?: string; venue?: string; location?: string; note?: string; status?: string }>();
  await c.env.DB.prepare(
    "UPDATE sessions SET date = ?, start_time = ?, venue = ?, location = ?, note = ?, status = ? WHERE id = ?"
  )
    .bind(
      body.date ?? existing.date,
      body.startTime ?? existing.start_time,
      body.venue ?? existing.venue,
      body.location !== undefined ? body.location : existing.location,
      body.note !== undefined ? body.note : existing.note,
      body.status ?? existing.status,
      id
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

// Set check-in list (replace all)
sessions.post("/:id/members", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
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
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();
  const body = await c.req.json<{ label: string; amount: number; type?: string }>();
  if (!body.label || body.amount == null) return c.json({ error: "label, amount required" }, 400);
  const costId = nanoid();
  await c.env.DB.prepare(
    "INSERT INTO costs (id, session_id, label, amount, type) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(costId, id, body.label, body.amount, body.type ?? "other")
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row, 201);
});

// Delete cost
sessions.delete("/:id/costs/:costId", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { costId } = c.req.param();
  await c.env.DB.prepare("DELETE FROM costs WHERE id = ?").bind(costId).run();
  return c.json({ success: true });
});

// Recalculate payments
sessions.post("/:id/recalculate", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.param();

  const totalRow = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM costs WHERE session_id = ?"
  ).bind(id).first<{ total: number }>();
  const total = totalRow?.total ?? 0;

  const attendees = await c.env.DB.prepare(
    "SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1"
  ).bind(id).all<{ member_id: string }>();

  const count = attendees.results.length;
  if (count === 0) return c.json({ error: "No attendees" }, 400);

  const perPerson = Math.ceil(total / count);

  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();

  if (attendees.results.length > 0) {
    const stmts = attendees.results.map((a) =>
      c.env.DB.prepare(
        "INSERT INTO payments (id, session_id, member_id, amount_owed, paid) VALUES (?, ?, ?, ?, 0)"
      ).bind(nanoid(), id, a.member_id, perPerson)
    );
    await c.env.DB.batch(stmts);
  }

  const payments = await c.env.DB.prepare("SELECT * FROM payments WHERE session_id = ?").bind(id).all();
  return c.json(payments.results);
});

export default sessions;
