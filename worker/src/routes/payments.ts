import { Hono } from "hono";
import { Env } from "../types";
import { sendPaymentMarkedPaidForPayment, sendPaymentReceivedForPayment } from "../paymentNotifications";

const payments = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type PaymentRow = {
  id: string;
  session_id: string;
  member_id: string;
  recipient_member_id?: string | null;
  payer_marked_paid?: number;
  payer_marked_paid_at?: string | null;
  paid: number;
  created_by?: string | null;
  group_id?: string | null;
  managers?: string | null;
  debtor_user_id?: string | null;
  recipient_user_id?: string | null;
};

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

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
  if (row.paid === 1) {
    return c.json({ error: "Payment is already confirmed and cannot be changed" }, 409);
  }

  const userId = c.get("userId");
  const isDebtorUser = row.debtor_user_id === userId;
  const isRecipientUser = row.recipient_user_id === userId;

  if (isDebtorUser) {
    if (row.payer_marked_paid === 1) {
      const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
      return c.json(updated);
    }

    const markedAt = new Date().toISOString();
    await c.env.DB.prepare("UPDATE payments SET payer_marked_paid = 1, payer_marked_paid_at = ? WHERE id = ?")
      .bind(markedAt, id)
      .run();

    queueTask(c, sendPaymentMarkedPaidForPayment(c.env, id, { markedAt }), `payment-marked-paid:${id}`);

    const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
    return c.json(updated);
  }

  if (!isRecipientUser) {
    return c.json({ error: "Only the payer or recipient can update this payment" }, 403);
  }

  if (row.payer_marked_paid !== 1) {
    return c.json({ error: "The payer must mark this payment as paid before the recipient can confirm it" }, 409);
  }

  const paidAt = new Date().toISOString();
  await c.env.DB.prepare("UPDATE payments SET paid = 1, paid_at = ? WHERE id = ?")
    .bind(paidAt, id)
    .run();

  queueTask(c, sendPaymentReceivedForPayment(c.env, id, { paidAt }), `payment-received:${id}`);

  const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
  return c.json(updated);
});

export default payments;
