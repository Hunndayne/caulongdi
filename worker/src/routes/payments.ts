import { Hono } from "hono";
import { Env } from "../types";

const payments = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type PaymentRow = {
  id: string;
  session_id: string;
  member_id: string;
  recipient_member_id?: string | null;
  paid: number;
  created_by?: string | null;
  group_id?: string | null;
  managers?: string | null;
  debtor_user_id?: string | null;
  recipient_user_id?: string | null;
};

async function canTogglePayment(c: any, payment: PaymentRow) {
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  if (userRole === "admin") return true;
  if (payment.created_by && payment.created_by === userId) return true;
  if (payment.debtor_user_id && payment.debtor_user_id === userId) return true;
  if (payment.recipient_user_id && payment.recipient_user_id === userId) return true;

  if (payment.managers) {
    try {
      const managers: string[] = JSON.parse(payment.managers);
      if (managers.includes(userId)) return true;
    } catch {
      // ignore malformed legacy data
    }
  }

  if (!payment.group_id) return false;

  const groupRole = await c.env.DB.prepare(`
    SELECT role
    FROM group_members
    WHERE group_id = ? AND user_id = ?
  `)
    .bind(payment.group_id, userId)
    .first() as { role: string } | null;

  return groupRole?.role === "admin";
}

payments.post("/:id/toggle", async (c) => {
  const { id } = c.req.param();
  const row = await c.env.DB.prepare(`
    SELECT
      p.*,
      s.created_by,
      s.group_id,
      s.managers,
      debtor.user_id AS debtor_user_id,
      recipient.user_id AS recipient_user_id
    FROM payments p
    JOIN sessions s ON s.id = p.session_id
    LEFT JOIN members debtor ON debtor.id = p.member_id
    LEFT JOIN members recipient ON recipient.id = p.recipient_member_id
    WHERE p.id = ?
  `)
    .bind(id)
    .first<PaymentRow>();

  if (!row) return c.json({ error: "Not found" }, 404);
  if (!(await canTogglePayment(c, row))) return c.json({ error: "Forbidden" }, 403);

  const newPaid = row.paid === 0 ? 1 : 0;
  const paidAt = newPaid === 1 ? new Date().toISOString() : null;

  await c.env.DB.prepare("UPDATE payments SET paid = ?, paid_at = ? WHERE id = ?")
    .bind(newPaid, paidAt, id)
    .run();

  const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
  return c.json(updated);
});

export default payments;
