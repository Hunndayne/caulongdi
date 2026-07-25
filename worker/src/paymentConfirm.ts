// Lõi xác nhận thanh toán dùng chung cho mọi nguồn đối soát:
//  - poll lịch sử giao dịch hũ Timo (timoPot.ts) — đường chính, cấu hình theo từng nhóm
//  - webhook Gmail Apps Script (routes/paymentWebhooks.ts) — đường cũ, giữ trong lúc chuyển đổi
//
// Mọi kiểm tra an toàn nằm ở đây để hai đường không lệch nhau.

import { Env } from "./types";
import { sendPaymentReceivedForPayment } from "./paymentNotifications";

// Mã trên QR: CLD = luồng tự xác nhận, TT = luồng thủ công cũ.
export const PAYMENT_CODE_PATTERN = /\b(?:TT|CLD)[-\s]*([A-Za-z0-9]{8,40})\b/i;

export function extractPaymentId(content: string) {
  return content.match(PAYMENT_CODE_PATTERN)?.[1] ?? null;
}

export function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

// Số tài khoản so khớp bỏ khoảng trắng/gạch, không phân biệt hoa thường:
// hũ Timo có cả dạng chữ (TIMO90C0908A658) và dạng số (9021254870255).
export function normalizeAccountNumber(value?: string | null) {
  return value?.replace(/[\s-]/g, "").toUpperCase() ?? "";
}

type PaymentMatchRow = {
  id: string;
  session_id: string;
  group_id?: string | null;
  payment_to_pot?: number | null;
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

function hasBankInfo(row: PaymentMatchRow, prefix: "recipient" | "fallback") {
  return Boolean(
    row[`${prefix}_bank_bin`] &&
      row[`${prefix}_bank_account_number`] &&
      row[`${prefix}_bank_account_name`]
  );
}

// Người thực sự nhận tiền trên QR: ưu tiên recipient của payment, không có thì lấy
// payment_recipient của buổi (bỏ tiền tố auto_), miễn không phải chính người nợ.
function getQrRecipient(row: PaymentMatchRow) {
  if (row.recipient_id && hasBankInfo(row, "recipient")) {
    return {
      email: normalizeEmail(row.recipient_email),
      name: row.recipient_name?.trim() || null,
      accountNumber: normalizeAccountNumber(row.recipient_bank_account_number),
    };
  }

  if (row.fallback_id && row.fallback_id !== row.member_id && hasBankInfo(row, "fallback")) {
    return {
      email: normalizeEmail(row.fallback_email),
      name: row.fallback_name?.trim() || null,
      accountNumber: normalizeAccountNumber(row.fallback_bank_account_number),
    };
  }

  return { email: "", name: null, accountNumber: "" };
}

function validIsoOrNow(value?: string | null) {
  if (!value) return new Date().toISOString();

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export type ConfirmOutcome =
  | { status: "confirmed"; paymentId: string; paidAt: string; recipientName: string | null; amount: number }
  | { status: "already_paid"; paymentId: string; paidAt: string | null }
  | { status: "not_found" }
  | { status: "wrong_group"; sessionGroupId: string | null }
  | { status: "no_recipient" }
  | { status: "recipient_not_eligible"; recipientEmail: string; recipientAccount: string }
  | { status: "not_pot_session" }
  | { status: "amount_mismatch"; expectedAmount: number; receivedAmount: number };

export type ConfirmOptions = {
  paymentId: string;
  amount: number;
  paidAt?: string | null;
  /** Payment phải thuộc nhóm này. Chặn hũ nhóm A xác nhận payment nhóm B. */
  expectGroupId?: string;
  /** Đường Gmail cũ: người nhận QR phải đúng email được phép tự xác nhận. */
  requireRecipientEmail?: string;
  /**
   * Đường hũ Timo: buổi chơi phải đặt thu tiền về hũ nhóm (sessions.payment_to_pot = 1).
   * Cố tình KHÔNG so với tài khoản cá nhân của người nhận — tài khoản hũ là của nhóm,
   * tài khoản cá nhân để hoàn tiền cho người ứng, hai thứ tách biệt.
   */
  requirePotSession?: boolean;
  /** Cho phép hoãn gửi email thông báo (waitUntil). Không truyền thì await luôn. */
  defer?: (task: Promise<unknown>) => void;
};

export async function confirmPaymentTransfer(
  env: Env,
  opts: ConfirmOptions
): Promise<ConfirmOutcome> {
  const row = await env.DB.prepare(`
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
      s.group_id,
      s.payment_to_pot,
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
    LEFT JOIN members fallback ON fallback.id = CASE
      WHEN s.payment_recipient LIKE 'auto_%' THEN substr(s.payment_recipient, 6)
      ELSE s.payment_recipient
    END
    LEFT JOIN users fallback_user ON fallback_user.id = fallback.user_id
    WHERE p.id = ?
  `)
    .bind(opts.paymentId)
    .first<PaymentMatchRow>();

  if (!row) return { status: "not_found" };

  if (opts.expectGroupId && row.group_id !== opts.expectGroupId) {
    return { status: "wrong_group", sessionGroupId: row.group_id ?? null };
  }

  // Thu về hũ: tiền vào tài khoản chung của nhóm nên payment CỐ TÌNH không có người nhận
  // cá nhân — phải xét trước, đừng để guard "không có người nhận" bên dưới loại oan.
  const potSession = row.payment_to_pot === 1;
  if (opts.requirePotSession && !potSession) {
    return { status: "not_pot_session" };
  }

  const qrRecipient = getQrRecipient(row);
  if (!potSession && !qrRecipient.email && !qrRecipient.accountNumber) {
    return { status: "no_recipient" };
  }

  if (opts.requireRecipientEmail && qrRecipient.email !== normalizeEmail(opts.requireRecipientEmail)) {
    return {
      status: "recipient_not_eligible",
      recipientEmail: qrRecipient.email,
      recipientAccount: qrRecipient.accountNumber,
    };
  }

  const expectedAmount = Math.ceil(Number(row.amount_owed));
  if (Math.round(opts.amount) !== expectedAmount) {
    return { status: "amount_mismatch", expectedAmount, receivedAmount: opts.amount };
  }

  if (row.paid === 1) {
    return { status: "already_paid", paymentId: row.id, paidAt: row.paid_at ?? null };
  }

  const paidAt = validIsoOrNow(opts.paidAt);
  await env.DB.prepare(`
    UPDATE payments
    SET payer_marked_paid = 1,
        payer_marked_paid_at = COALESCE(payer_marked_paid_at, ?),
        paid = 1,
        paid_at = ?
    WHERE id = ?
  `)
    .bind(paidAt, paidAt, row.id)
    .run();

  const notify = sendPaymentReceivedForPayment(env, row.id, {
    recipientName: qrRecipient.name,
    paidAt,
  }).catch((error) => {
    console.error(`[payment-confirm] gửi mail thất bại ${row.id}`, error);
  });

  if (opts.defer) opts.defer(notify);
  else await notify;

  return {
    status: "confirmed",
    paymentId: row.id,
    paidAt,
    recipientName: qrRecipient.name,
    amount: expectedAmount,
  };
}
