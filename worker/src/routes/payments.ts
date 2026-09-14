import { Hono } from "hono";
import { Env } from "../types";
import { sendPaymentMarkedPaidForPayment, sendPaymentReceivedForPayment } from "../paymentNotifications";
import { pollPotForGroup } from "../timoPot";

const payments = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type PaymentRow = {
  id: string;
  session_id: string;
  member_id: string;
  recipient_member_id?: string | null;
  payer_marked_paid?: number;
  payer_marked_paid_at?: string | null;
  payment_to_pot?: number | null;
  paid: number;
  created_by?: string | null;
  group_id?: string | null;
  managers?: string | null;
  debtor_user_id?: string | null;
  recipient_user_id?: string | null;
  recipient_is_walkin?: number | null;
  recipient_ref_user_id?: string | null;
};

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

// Người quản lý buổi (admin site / người tạo / manager / admin nhóm) — tách riêng để
// vừa gác quyền toggle, vừa cho phép xác nhận thay khi người nhận là vãng lai không có tài khoản.
async function isSessionManager(c: any, payment: PaymentRow) {
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  if (userRole === "admin") return true;
  if (payment.created_by && payment.created_by === userId) return true;

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

// Người nhận là vãng lai thì không có tài khoản để tự xác nhận: người ref bảo lãnh nhận thay.
function isWalkinRecipientRefUser(payment: PaymentRow, userId: string) {
  return payment.recipient_is_walkin === 1
    && Boolean(payment.recipient_ref_user_id)
    && payment.recipient_ref_user_id === userId;
}

async function canTogglePayment(c: any, payment: PaymentRow) {
  const userId = c.get("userId");

  if (payment.debtor_user_id && payment.debtor_user_id === userId) return true;
  if (payment.recipient_user_id && payment.recipient_user_id === userId) return true;
  if (isWalkinRecipientRefUser(payment, userId)) return true;

  return isSessionManager(c, payment);
}

payments.post("/:id/toggle", async (c) => {
  const { id } = c.req.param();
  const row = await c.env.DB.prepare(`
    SELECT
      p.*,
      s.created_by,
      s.group_id,
      s.managers,
      s.payment_to_pot,
      debtor.user_id AS debtor_user_id,
      recipient.user_id AS recipient_user_id,
      recipient.is_walkin AS recipient_is_walkin,
      recipient_ref.user_id AS recipient_ref_user_id
    FROM payments p
    JOIN sessions s ON s.id = p.session_id
    LEFT JOIN members debtor ON debtor.id = p.member_id
    LEFT JOIN members recipient ON recipient.id = p.recipient_member_id
    LEFT JOIN members recipient_ref ON recipient_ref.id = recipient.ref_member_id
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
  const isRecipientUser = row.recipient_user_id === userId;
  // Người trả vừa là ref của vãng lai nhận tiền → tiền vào đúng túi mình, xác nhận thẳng (paid)
  // ở nhánh dưới thay vì chỉ "đánh dấu đã trả" rồi treo chờ chính mình xác nhận.
  const isDebtorUser = row.debtor_user_id === userId && !isWalkinRecipientRefUser(row, userId);

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

    // Buổi thu về hũ: đối soát ngay, khỏi chờ nhịp 1 tiếng — người vừa chuyển thật thì
    // payment được xác nhận luôn thay vì treo ở trạng thái "chờ xác nhận".
    if (row.payment_to_pot === 1 && row.group_id) {
      queueTask(c, pollPotForGroup(c.env, row.group_id), `pot-check:${id}`);
    }

    const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
    return c.json(updated);
  }

  // Thu về hũ thì payment không có người nhận cá nhân (recipient_member_id NULL), nên người
  // quản lý nhóm/buổi xác nhận thay — canTogglePayment ở trên đã lọc quyền.
  const potMode = row.payment_to_pot === 1 && !row.recipient_member_id;
  // Người nhận là vãng lai (không có tài khoản): ref bảo lãnh, hoặc người quản lý, xác nhận thay.
  const walkinRecipientConfirm = row.recipient_is_walkin === 1
    && (isWalkinRecipientRefUser(row, userId) || (await isSessionManager(c, row)));
  if (!isRecipientUser && !potMode && !walkinRecipientConfirm) {
    return c.json({ error: "Only the payer or recipient can update this payment" }, 403);
  }

  const paidAt = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE payments SET payer_marked_paid = 1, payer_marked_paid_at = COALESCE(payer_marked_paid_at, ?), paid = 1, paid_at = ? WHERE id = ?"
  )
    .bind(paidAt, paidAt, id)
    .run();

  queueTask(c, sendPaymentReceivedForPayment(c.env, id, { paidAt }), `payment-received:${id}`);

  const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
  return c.json(updated);
});

export default payments;
