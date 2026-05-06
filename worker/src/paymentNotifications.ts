import { sendPaymentMarkedPaidNotification, sendPaymentReceivedNotification } from "./email";
import { Env } from "./types";

type PaymentReceivedRow = {
  session_id: string;
  amount_owed: number;
  paid_at?: string | null;
  venue: string;
  date: string;
  start_time: string;
  debtor_name: string;
  debtor_email?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
};

export async function sendPaymentReceivedForPayment(
  env: Env,
  paymentId: string,
  options?: { recipientName?: string | null; paidAt?: string | null }
) {
  const row = await env.DB.prepare(`
    SELECT
      p.session_id,
      p.amount_owed,
      p.paid_at,
      s.venue,
      s.date,
      s.start_time,
      debtor_member.name AS debtor_name,
      debtor_user.email AS debtor_email,
      recipient_member.name AS recipient_name,
      recipient_user.email AS recipient_email
    FROM payments p
    JOIN sessions s ON s.id = p.session_id
    JOIN members debtor_member ON debtor_member.id = p.member_id
    LEFT JOIN users debtor_user ON debtor_user.id = debtor_member.user_id
    LEFT JOIN members recipient_member ON recipient_member.id = p.recipient_member_id
    LEFT JOIN users recipient_user ON recipient_user.id = recipient_member.user_id
    WHERE p.id = ?
  `)
    .bind(paymentId)
    .first<PaymentReceivedRow>();

  const debtorEmail = row?.debtor_email?.trim();
  if (!row || !debtorEmail) return;

  await sendPaymentReceivedNotification(env, {
    debtorEmail,
    debtorName: row.debtor_name,
    recipientName: options?.recipientName?.trim() || row.recipient_name?.trim() || "người nhận",
    amount: row.amount_owed,
    venue: row.venue,
    date: row.date,
    startTime: row.start_time,
    sessionId: row.session_id,
    paidAt: options?.paidAt ?? row.paid_at ?? null,
  });
}

export async function sendPaymentMarkedPaidForPayment(
  env: Env,
  paymentId: string,
  options?: { markedAt?: string | null }
) {
  const row = await env.DB.prepare(`
    SELECT
      p.session_id,
      p.amount_owed,
      p.payer_marked_paid_at,
      s.venue,
      s.date,
      s.start_time,
      debtor_member.name AS debtor_name,
      recipient_member.name AS recipient_name,
      recipient_user.email AS recipient_email
    FROM payments p
    JOIN sessions s ON s.id = p.session_id
    JOIN members debtor_member ON debtor_member.id = p.member_id
    LEFT JOIN members recipient_member ON recipient_member.id = p.recipient_member_id
    LEFT JOIN users recipient_user ON recipient_user.id = recipient_member.user_id
    WHERE p.id = ?
  `)
    .bind(paymentId)
    .first<PaymentReceivedRow & { payer_marked_paid_at?: string | null }>();

  const recipientEmail = row?.recipient_email?.trim();
  if (!row || !recipientEmail) return;

  await sendPaymentMarkedPaidNotification(env, {
    recipientEmail,
    recipientName: row.recipient_name?.trim() || "người nhận",
    debtorName: row.debtor_name,
    amount: row.amount_owed,
    venue: row.venue,
    date: row.date,
    startTime: row.start_time,
    sessionId: row.session_id,
    markedAt: options?.markedAt ?? row.payer_marked_paid_at ?? null,
  });
}
