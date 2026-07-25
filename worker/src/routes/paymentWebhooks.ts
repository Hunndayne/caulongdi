import { Hono } from "hono";
import { Env } from "../types";
import { confirmPaymentTransfer, extractPaymentId } from "../paymentConfirm";

// Đường cũ: Gmail Apps Script đọc mail biến động số dư Timo rồi gọi vào đây.
// Chỉ chạy được cho một hộp thư duy nhất → chỉ nhóm có người đó mới tự xác nhận được.
// Đường mới thay thế: poll lịch sử giao dịch hũ Timo theo từng nhóm (../timoPot.ts).
const DEFAULT_AUTOCONFIRM_EMAIL = "tranthanhhung1641@gmail.com";

const paymentWebhooks = new Hono<{ Bindings: Env }>();

type BankTransferWebhookBody = {
  amount?: number | string;
  content?: string;
  recipientEmail?: string;
  externalId?: string;
  receivedAt?: string;
};

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function bearerToken(header: string | undefined | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
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
  if (!paymentId) return c.json({ error: "Payment code TT/CLD-<paymentId> not found" }, 400);

  const autoConfirmEmail = normalizeEmail(c.env.PAYMENT_AUTOCONFIRM_EMAIL || DEFAULT_AUTOCONFIRM_EMAIL);
  const reportedRecipientEmail = normalizeEmail(body.recipientEmail);
  if (reportedRecipientEmail && reportedRecipientEmail !== autoConfirmEmail) {
    return c.json({ error: "Recipient email is not eligible for auto confirmation" }, 409);
  }

  const result = await confirmPaymentTransfer(c.env, {
    paymentId,
    amount,
    paidAt: body.receivedAt,
    requireRecipientEmail: autoConfirmEmail,
    defer: (task) => c.executionCtx?.waitUntil?.(task),
  });

  switch (result.status) {
    case "not_found":
      return c.json({ error: "Payment not found" }, 404);
    case "no_recipient":
      return c.json({ error: "Payment has no QR recipient" }, 409);
    case "recipient_not_eligible":
      return c.json({ error: "Payment QR recipient is not eligible for auto confirmation" }, 409);
    case "amount_mismatch":
      return c.json({
        error: "Payment amount does not match",
        expectedAmount: result.expectedAmount,
        receivedAmount: result.receivedAmount,
      }, 409);
    case "already_paid":
      return c.json({
        success: true,
        alreadyPaid: true,
        paymentId: result.paymentId,
        paidAt: result.paidAt,
      });
    case "confirmed":
      console.info("[payment-webhook] confirmed payment", {
        paymentId: result.paymentId,
        externalId: body.externalId ?? null,
      });
      return c.json({
        success: true,
        alreadyPaid: false,
        paymentId: result.paymentId,
        paidAt: result.paidAt,
      });
    default:
      return c.json({ error: `Unexpected confirm status: ${result.status}` }, 409);
  }
});

export default paymentWebhooks;
