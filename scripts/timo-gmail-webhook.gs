const WEBHOOK_URL = "https://caulong.hunn.io.vn/api/payment-webhooks/bank-transfer";
const WEBHOOK_SECRET = "PASTE_PAYMENT_WEBHOOK_SECRET_HERE";
const RECIPIENT_EMAIL = "tranthanhhung1641@gmail.com";
const PROCESSED_PROPERTY = "PROCESSED_TIMO_EMAILS";
const MAX_PROCESSED_IDS = 120;

function scanTimoPaymentEmails() {
  logInfo("scan started", { at: new Date().toISOString(), webhookUrl: WEBHOOK_URL });

  const props = PropertiesService.getScriptProperties();
  const processed = readProcessedMessageIds(props);

  const query = [
    "from:support@timo.vn",
    'subject:"Thông báo thay đổi số dư tài khoản"',
    "newer_than:14d",
  ].join(" ");

  logInfo("gmail search", { query: query });
  const threads = GmailApp.search(query, 0, 20);
  logInfo("gmail search completed", { threadCount: threads.length });

  const stats = {
    checked: 0,
    skippedProcessed: 0,
    skippedUnmatched: 0,
    sent: 0,
    confirmed: 0,
    failed: 0,
  };

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      stats.checked += 1;

      const messageId = message.getId();
      const messageContext = {
        messageId: messageId,
        date: message.getDate().toISOString(),
        subject: message.getSubject(),
      };

      logInfo("checking message", messageContext);

      if (processed[messageId]) {
        stats.skippedProcessed += 1;
        logInfo("skip processed message", messageContext);
        return;
      }

      const parsed = parseTimoEmail(message.getPlainBody());
      if (!parsed) {
        stats.skippedUnmatched += 1;
        logInfo("skip unmatched message", messageContext);
        return;
      }

      const payload = {
          amount: parsed.amount,
          content: parsed.description,
          recipientEmail: RECIPIENT_EMAIL,
          externalId: messageId,
          receivedAt: message.getDate().toISOString(),
      };

      logInfo("sending webhook", {
        messageId: messageId,
        amount: payload.amount,
        content: payload.content,
        receivedAt: payload.receivedAt,
      });

      let response;
      try {
        response = UrlFetchApp.fetch(WEBHOOK_URL, {
          method: "post",
          contentType: "application/json",
          muteHttpExceptions: true,
          headers: {
            Authorization: "Bearer " + WEBHOOK_SECRET,
          },
          payload: JSON.stringify(payload),
        });
      } catch (error) {
        stats.failed += 1;
        logError("webhook fetch threw", {
          messageId: messageId,
          error: errorToString(error),
        });
        return;
      }

      stats.sent += 1;

      const status = response.getResponseCode();
      const responseText = response.getContentText();
      if (status >= 200 && status < 300) {
        processed[messageId] = new Date().toISOString();
        writeProcessedMessageIds(props, processed);
        stats.confirmed += 1;
        logInfo("webhook confirmed", {
          messageId: messageId,
          status: status,
          response: responseText,
        });
      } else {
        stats.failed += 1;
        logWarn("webhook failed", {
          messageId: messageId,
          status: status,
          response: responseText,
        });
      }
    });
  });

  logInfo("scan finished", stats);
}

function parseTimoEmail(body) {
  const amountMatch = body.match(/vừa tăng\s+([\d.,]+)\s*VND/i);
  const descMatch = body.match(/Mô tả:\s*(.+?)(?:\r?\n|$)/i);

  if (!amountMatch) {
    logInfo("parse skipped: amount line not found", { bodyExcerpt: bodyExcerpt(body) });
    return null;
  }

  if (!descMatch) {
    logInfo("parse skipped: description line not found", { bodyExcerpt: bodyExcerpt(body) });
    return null;
  }

  const amount = Number(amountMatch[1].replace(/[.,]/g, ""));
  const description = descMatch[1].trim();

  if (!amount || amount <= 0) {
    logInfo("parse skipped: invalid amount", { rawAmount: amountMatch[1] });
    return null;
  }

  if (!/\bCLD[-\s]*[A-Za-z0-9]{8,40}\b/i.test(description)) {
    logInfo("parse skipped: CLD payment code not found", { description: description });
    return null;
  }

  logInfo("parse matched", { amount: amount, description: description });

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

function bodyExcerpt(body) {
  return String(body)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function logInfo(message, details) {
  console.log(formatLogMessage("INFO", message, details));
}

function logWarn(message, details) {
  console.warn(formatLogMessage("WARN", message, details));
}

function logError(message, details) {
  console.error(formatLogMessage("ERROR", message, details));
}

function formatLogMessage(level, message, details) {
  const base = `[TimoWebhook] ${level} ${message}`;
  if (details === undefined) return base;

  try {
    return base + " " + JSON.stringify(details);
  } catch (error) {
    return base + " " + String(details);
  }
}

function errorToString(error) {
  if (error && error.stack) return String(error.stack);
  if (error && error.message) return String(error.message);
  return String(error);
}
