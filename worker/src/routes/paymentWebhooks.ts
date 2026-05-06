import { Hono } from "hono";
import { Env } from "../types";
import { sendPaymentReceivedForPayment } from "../paymentNotifications";

const DEFAULT_AUTOCONFIRM_EMAIL = "tranthanhhung1641@gmail.com";

const paymentWebhooks = new Hono<{ Bindings: Env }>();

type BankTransferWebhookBody = {
  amount?: number | string;
  content?: string;
  recipientEmail?: string;
  externalId?: string;
  receivedAt?: string;
};

type PaymentMatchRow = {
  id: string;
  session_id: string;
  member_id: string;
  recipient_member_id?: string | null;
  amount_owed: number;
  payer_marked_paid?: number;
  payer_marked_paid_at?: string | null;
  paid: number;
  paid_at?: string | null;
  payment_recipient?: string | null;
  recipient_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  recipient_bank_bin?: string | null;
  recipient_bank_account_number?: string | null;
  recipient_bank_account_name?: string | null;
  fallback_id?: string | null;
  fallback_name?: string | null;
  fallback_email?: string | null;
  fallback_bank_bin?: string | null;
  fallback_bank_account_number?: string | null;
  fallback_bank_account_name?: string | null;
};

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function bearerToken(header: string | undefined | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

function parseAmount(value: BankTransferWebhookBody["amount"]) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.replace(/[^\d]/g, "");
  if (!normalized) return null;

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function extractPaymentId(content: string) {
  const match = content.match(/\bCLD[-\s]*([A-Za-z0-9]{8,40})\b/i);
  return match?.[1] ?? null;
}

function validIsoOrNow(value?: string) {
  if (!value) return new Date().toISOString();

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function hasBankInfo(row: PaymentMatchRow, prefix: "recipient" | "fallback") {
  return Boolean(
    row[`${prefix}_bank_bin`] &&
      row[`${prefix}_bank_account_number`] &&
      row[`${prefix}_bank_account_name`]
  );
}

function getQrRecipient(row: PaymentMatchRow) {
  if (row.recipient_id && hasBankInfo(row, "recipient")) {
    return {
      email: normalizeEmail(row.recipient_email),
      name: row.recipient_name?.trim() || null,
    };
  }

  if (row.fallback_id && row.fallback_id !== row.member_id && hasBankInfo(row, "fallback")) {
    return {
      email: normalizeEmail(row.fallback_email),
      name: row.fallback_name?.trim() || null,
    };
  }

  return { email: "", name: null };
}

paymentWebhooks.post("/bank-transfer", async (c) => {
  const expectedSecret = c.env.PAYMENT_WEBHOOK_SECRET?.trim();
  if (!expectedSecret) return c.json({ error: "Payment webhook secret is not configured" }, 500);

  const token = bearerToken(c.req.header("Authorization"));
  if (!token || token !== expectedSecret) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<BankTransferWebhookBody>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const amount = parseAmount(body.amount);
  const content = body.content?.trim() ?? "";
  const paymentId = extractPaymentId(content);

  if (!amount || amount <= 0) return c.json({ error: "amount must be a positive number" }, 400);
  if (!content) return c.json({ error: "content is required" }, 400);
  if (!paymentId) return c.json({ error: "Payment code CLD<id> not found" }, 400);

  const autoConfirmEmail = normalizeEmail(c.env.PAYMENT_AUTOCONFIRM_EMAIL || DEFAULT_AUTOCONFIRM_EMAIL);
  const reportedRecipientEmail = normalizeEmail(body.recipientEmail);
  if (reportedRecipientEmail && reportedRecipientEmail !== autoConfirmEmail) {
    return c.json({ error: "Recipient email is not eligible for auto confirmation" }, 409);
  }

  const row = await c.env.DB.prepare(`
    SELECT
      p.id,
      p.session_id,
      p.member_id,
      p.recipient_member_id,
      p.amount_owed,
      p.payer_marked_paid,
      p.payer_marked_paid_at,
      p.paid,
      p.paid_at,
      s.payment_recipient,
      recipient.id AS recipient_id,
      recipient.name AS recipient_name,
      recipient_user.email AS recipient_email,
      recipient_user.bank_bin AS recipient_bank_bin,
      recipient_user.bank_account_number AS recipient_bank_account_number,
      recipient_user.bank_account_name AS recipient_bank_account_name,
      fallback.id AS fallback_id,
      fallback.name AS fallback_name,
      fallback_user.email AS fallback_email,
      fallback_user.bank_bin AS fallback_bank_bin,
      fallback_user.bank_account_number AS fallback_bank_account_number,
      fallback_user.bank_account_name AS fallback_bank_account_name
    FROM payments p
    JOIN sessions s ON s.id = p.session_id
    LEFT JOIN members recipient ON recipient.id = p.recipient_member_id
    LEFT JOIN users recipient_user ON recipient_user.id = recipient.user_id
    LEFT JOIN members fallback ON fallback.id = s.payment_recipient
    LEFT JOIN users fallback_user ON fallback_user.id = fallback.user_id
    WHERE p.id = ?
  `)
    .bind(paymentId)
    .first<PaymentMatchRow>();

  if (!row) return c.json({ error: "Payment not found" }, 404);

  const qrRecipient = getQrRecipient(row);
  if (!qrRecipient.email) return c.json({ error: "Payment has no QR recipient" }, 409);
  if (qrRecipient.email !== autoConfirmEmail) {
    return c.json({ error: "Payment QR recipient is not eligible for auto confirmation" }, 409);
  }

  const expectedAmount = Math.ceil(Number(row.amount_owed));
  if (Math.round(amount) !== expectedAmount) {
    return c.json({
      error: "Payment amount does not match",
      expectedAmount,
      receivedAmount: amount,
    }, 409);
  }

  if (row.paid === 1) {
    return c.json({
      success: true,
      alreadyPaid: true,
      paymentId: row.id,
      paidAt: row.paid_at ?? null,
    });
  }

  const paidAt = validIsoOrNow(body.receivedAt);
  await c.env.DB.prepare(`
    UPDATE payments
    SET payer_marked_paid = 1,
        payer_marked_paid_at = COALESCE(payer_marked_paid_at, ?),
        paid = 1,
        paid_at = ?
    WHERE id = ?
  `)
    .bind(paidAt, paidAt, row.id)
    .run();

  queueTask(
    c,
    sendPaymentReceivedForPayment(c.env, row.id, { recipientName: qrRecipient.name, paidAt }),
    `payment-received:${row.id}`
  );

  console.info("[payment-webhook] confirmed payment", {
    paymentId: row.id,
    externalId: body.externalId ?? null,
  });

  return c.json({
    success: true,
    alreadyPaid: false,
    paymentId: row.id,
    paidAt,
  });
});

export default paymentWebhooks;
