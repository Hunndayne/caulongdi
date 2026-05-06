const WEBHOOK_URL = "https://caulong.hunn.io.vn/api/payment-webhooks/bank-transfer";
const WEBHOOK_SECRET = "PASTE_PAYMENT_WEBHOOK_SECRET_HERE";
const RECIPIENT_EMAIL = "tranthanhhung1641@gmail.com";
const PROCESSED_PROPERTY = "PROCESSED_TIMO_EMAILS";
const MAX_PROCESSED_IDS = 120;

function scanTimoPaymentEmails() {
  const props = PropertiesService.getScriptProperties();
  const processed = readProcessedMessageIds(props);

  const query = [
    "from:support@timo.vn",
    'subject:"Thông báo thay đổi số dư tài khoản"',
    "newer_than:14d",
  ].join(" ");

  const threads = GmailApp.search(query, 0, 20);

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const messageId = message.getId();
      if (processed[messageId]) return;

      const parsed = parseTimoEmail(message.getPlainBody());
      if (!parsed) return;

      const response = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: "post",
        contentType: "application/json",
        muteHttpExceptions: true,
        headers: {
          Authorization: "Bearer " + WEBHOOK_SECRET,
        },
        payload: JSON.stringify({
          amount: parsed.amount,
          content: parsed.description,
          recipientEmail: RECIPIENT_EMAIL,
          externalId: messageId,
          receivedAt: message.getDate().toISOString(),
        }),
      });

      const status = response.getResponseCode();

      if (status >= 200 && status < 300) {
        processed[messageId] = new Date().toISOString();
        writeProcessedMessageIds(props, processed);
      } else {
        console.warn("Webhook failed", status, response.getContentText());
      }
    });
  });
}

function parseTimoEmail(body) {
  const amountMatch = body.match(/vừa tăng\s+([\d.,]+)\s*VND/i);
  const descMatch = body.match(/Mô tả:\s*(.+?)(?:\r?\n|$)/i);

  if (!amountMatch || !descMatch) return null;

  const amount = Number(amountMatch[1].replace(/[.,]/g, ""));
  const description = descMatch[1].trim();

  if (!amount || amount <= 0) return null;
  if (!/\bCLD[-\s][A-Za-z0-9]+\b/i.test(description)) return null;

  return { amount, description };
}

function readProcessedMessageIds(props) {
  try {
    return JSON.parse(props.getProperty(PROCESSED_PROPERTY) || "{}");
  } catch (error) {
    console.warn("Failed to read processed Timo email ids", error);
    return {};
  }
}

function writeProcessedMessageIds(props, processed) {
  const entries = Object.entries(processed)
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, MAX_PROCESSED_IDS);

  props.setProperty(PROCESSED_PROPERTY, JSON.stringify(Object.fromEntries(entries)));
}
