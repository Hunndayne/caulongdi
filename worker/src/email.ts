import { connect } from "cloudflare:sockets";
import { Env } from "./types";

type MailMessage = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
};

type SessionNotificationInput = {
  groupName: string;
  creatorName: string;
  venue: string;
  date: string;
  startTime: string;
  location?: string | null;
  note?: string | null;
  sessionId: string;
  recipients: string[];
};

type PaymentNotificationInput = {
  debtorName: string;
  debtorEmail: string;
  venue: string;
  date: string;
  startTime: string;
  sessionId: string;
  lines: { recipientName: string; amount: number }[];
};

type PaymentReceivedNotificationInput = {
  debtorName: string;
  debtorEmail: string;
  recipientName: string;
  amount: number;
  venue: string;
  date: string;
  startTime: string;
  sessionId: string;
  paidAt?: string | null;
};

type PaymentMarkedPaidNotificationInput = {
  debtorName: string;
  recipientName: string;
  recipientEmail: string;
  amount: number;
  venue: string;
  date: string;
  startTime: string;
  sessionId: string;
  markedAt?: string | null;
};

type GroupInviteNotificationInput = {
  groupName: string;
  groupDescription?: string | null;
  invitedName?: string | null;
  invitedEmail: string;
  invitedByName: string;
  role: "admin" | "member";
};

type EmailFact = {
  label: string;
  value: string;
};

const SMTP_OK_CODES = new Set([220, 221, 235, 250, 251, 334, 354]);

function isConfigured(env: Env) {
  return Boolean(env.SMTP_SERVER && env.SMTP_PORT && env.SMTP_LOGIN && env.SMTP_PASSWORD);
}

function normalizeUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrapBase64(value: string, lineLength = 76) {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += lineLength) {
    lines.push(value.slice(index, index + lineLength));
  }
  return lines.join("\r\n");
}

function encodeHeader(value: string) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${toBase64(value)}?=`;
}

function formatAddress(email: string, name?: string) {
  if (!name) return `<${email}>`;
  return `${encodeHeader(name)} <${email}>`;
}

function dotStuff(value: string) {
  return value
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function hostForMessageId(frontendUrl: string) {
  try {
    return new URL(frontendUrl).hostname;
  } catch {
    return "localhost";
  }
}

function buildMimeMessage(env: Env, message: MailMessage) {
  const senderEmail = env.SMTP_FROM_EMAIL || env.SMTP_LOGIN;
  const senderName = env.SMTP_FROM_NAME || "Hội cầu lông";
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  const toHeader = recipients.length === 1 ? formatAddress(recipients[0]) : "undisclosed-recipients:;";
  const boundary = `cf-worker-${crypto.randomUUID()}`;
  const messageId = `<${crypto.randomUUID()}@${hostForMessageId(env.FRONTEND_URL)}>`;

  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(toBase64(message.text)),
  ];

  if (message.html) {
    parts.push(
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(toBase64(message.html)),
    );
  }

  parts.push(`--${boundary}--`, "");

  return [
    `From: ${formatAddress(senderEmail, senderName)}`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    "Content-Language: vi",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    parts.join("\r\n"),
  ].join("\r\n");
}

function renderFacts(facts: EmailFact[]) {
  return facts.map((fact) => `
    <tr>
      <td style="padding: 0 0 8px; color: #6b7280; font-size: 13px; width: 120px; vertical-align: top;">${escapeHtml(fact.label)}</td>
      <td style="padding: 0 0 8px; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(fact.value)}</td>
    </tr>
  `).join("");
}

function renderButton(href: string, label: string) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0 12px;">
      <tr>
        <td bgcolor="#16a34a" style="border-radius: 10px;">
          <a href="${escapeHtml(href)}" style="display: inline-block; padding: 12px 18px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function renderLinkHint(url: string) {
  return `
    <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.6;">
      Nếu nút bấm mở ra link theo dõi của nhà cung cấp email, link đích của ứng dụng là:
    </p>
    <p style="margin: 8px 0 0; padding: 10px 12px; border-radius: 10px; background: #f3f4f6; color: #111827; font-size: 12px; line-height: 1.6; word-break: break-all;">
      ${escapeHtml(url)}
    </p>
  `;
}

function renderEmailShell(options: {
  preheader: string;
  title: string;
  intro: string;
  facts?: EmailFact[];
  htmlBlocks?: string[];
  ctaHref?: string;
  ctaLabel?: string;
  footerNote?: string;
}) {
  const facts = options.facts?.length ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 18px 0 4px;">
      ${renderFacts(options.facts)}
    </table>
  ` : "";

  const bodyBlocks = options.htmlBlocks?.join("") ?? "";
  const cta = options.ctaHref && options.ctaLabel ? renderButton(options.ctaHref, options.ctaLabel) : "";
  const linkHint = options.ctaHref ? renderLinkHint(options.ctaHref) : "";
  const footerNote = options.footerNote ? `<p style="margin: 18px 0 0; color: #6b7280; font-size: 12px; line-height: 1.6;">${escapeHtml(options.footerNote)}</p>` : "";

  return `
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #f3f4f6; font-family: Arial, Helvetica, sans-serif; color: #111827;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">
      ${escapeHtml(options.preheader)}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6; padding: 24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 640px;">
            <tr>
              <td style="padding: 0 0 16px; text-align: center; color: #166534; font-size: 13px; font-weight: 700; letter-spacing: 0.02em;">
                HỘI CẦU LÔNG
              </td>
            </tr>
            <tr>
              <td style="background: #ffffff; border-radius: 18px; padding: 28px 24px; box-shadow: 0 8px 24px rgba(17, 24, 39, 0.08);">
                <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 1.3; color: #111827;">
                  ${escapeHtml(options.title)}
                </h1>
                <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #374151;">
                  ${escapeHtml(options.intro)}
                </p>
                ${facts}
                ${bodyBlocks}
                ${cta}
                ${linkHint}
                ${footerNote}
              </td>
            </tr>
            <tr>
              <td style="padding: 16px 8px 0; text-align: center; color: #9ca3af; font-size: 12px; line-height: 1.6;">
                Email này được gửi tự động từ hệ thống quản lý lịch chơi của nhóm.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

class SmtpClient {
  private socket: ReturnType<typeof connect>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buffer = "";

  private constructor(socket: ReturnType<typeof connect>) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async connectToServer(env: Env) {
    const port = Number(env.SMTP_PORT || "587");
    const socket = connect(
      { hostname: env.SMTP_SERVER, port },
      { secureTransport: "starttls", allowHalfOpen: false }
    );
    await socket.opened;
    const client = new SmtpClient(socket);
    await client.expect([220]);
    return client;
  }

  async close() {
    try {
      await this.writer.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.socket.close();
    } catch {
      // ignore socket close errors
    }
  }

  async sendMail(env: Env, message: MailMessage) {
    const senderEmail = env.SMTP_FROM_EMAIL || env.SMTP_LOGIN;
    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    const heloHost = hostForMessageId(env.FRONTEND_URL);

    await this.command(`EHLO ${heloHost}`, [250]);
    await this.command("STARTTLS", [220]);
    await this.upgradeTls();
    await this.command(`EHLO ${heloHost}`, [250]);
    await this.command("AUTH LOGIN", [334]);
    await this.command(toBase64(env.SMTP_LOGIN), [334]);
    await this.command(toBase64(env.SMTP_PASSWORD), [235]);
    await this.command(`MAIL FROM:<${senderEmail}>`, [250]);

    for (const recipient of recipients) {
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }

    await this.command("DATA", [354]);
    await this.writeRaw(`${dotStuff(buildMimeMessage(env, message))}\r\n.\r\n`);
    await this.expect([250]);
    await this.command("QUIT", [221]);
  }

  private async upgradeTls() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    await this.socket.opened;
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = "";
  }

  private async command(command: string, expected: number[]) {
    await this.writeRaw(`${command}\r\n`);
    return this.expect(expected);
  }

  private async writeRaw(value: string) {
    await this.writer.write(this.encoder.encode(value));
  }

  private async expect(expected: number[]) {
    const response = await this.readResponse();
    if (!expected.includes(response.code)) {
      throw new Error(`SMTP ${response.code}: ${response.message}`);
    }
    return response;
  }

  private async readResponse(): Promise<{ code: number; message: string }> {
    const lines: string[] = [];

    while (true) {
      const nextLine = await this.readLine();
      if (nextLine === null) {
        throw new Error("SMTP connection closed unexpectedly");
      }

      lines.push(nextLine);
      if (/^\d{3} /.test(nextLine)) {
        return {
          code: Number(nextLine.slice(0, 3)),
          message: lines.join("\n"),
        };
      }
    }
  }

  private async readLine(): Promise<string | null> {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newlineIndex + 1);
        return line;
      }

      const { value, done } = await this.reader.read();
      if (done) {
        if (!this.buffer) return null;
        const line = this.buffer.replace(/\r$/, "");
        this.buffer = "";
        return line;
      }

      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

export async function sendMail(env: Env, message: MailMessage) {
  if (!isConfigured(env)) {
    throw new Error("SMTP is not fully configured");
  }

  const client = await SmtpClient.connectToServer(env);
  try {
    await client.sendMail(env, message);
  } finally {
    await client.close();
  }
}

export async function sendNewSessionNotification(env: Env, input: SessionNotificationInput) {
  if (input.recipients.length === 0) return;

  const sessionUrl = normalizeUrl(env.FRONTEND_URL, `/sessions/${input.sessionId}`);
  const textLines = [
    `Nhóm ${input.groupName} vừa có lịch chơi mới.`,
    "",
    `Người tạo: ${input.creatorName}`,
    `Sân: ${input.venue}`,
    `Thời gian: ${formatDate(input.date)} lúc ${input.startTime}`,
    input.location ? `Địa điểm: ${input.location}` : "",
    input.note ? `Ghi chú: ${input.note}` : "",
    "",
    `Xem chi tiết: ${sessionUrl}`,
  ].filter(Boolean);

  await sendMail(env, {
    to: input.recipients,
    subject: `Lịch chơi mới trong nhóm ${input.groupName}`,
    text: textLines.join("\n"),
    html: renderEmailShell({
      preheader: `Lịch chơi mới tại ${input.venue} vào ${formatDate(input.date)}.`,
      title: "Có lịch chơi mới trong nhóm",
      intro: `Nhóm ${input.groupName} vừa có thêm một buổi chơi mới. Bạn có thể mở app để xem chi tiết và tham gia.`,
      facts: [
        { label: "Người tạo", value: input.creatorName },
        { label: "Sân", value: input.venue },
        { label: "Thời gian", value: `${formatDate(input.date)} lúc ${input.startTime}` },
        ...(input.location ? [{ label: "Địa điểm", value: input.location }] : []),
      ],
      htmlBlocks: input.note ? [
        `<div style="margin-top: 12px; padding: 14px 16px; border-radius: 12px; background: #f9fafb; color: #374151; font-size: 14px; line-height: 1.7;">
          <strong style="color: #111827;">Ghi chú:</strong><br />
          ${escapeHtml(input.note)}
        </div>`,
      ] : [],
      ctaHref: sessionUrl,
      ctaLabel: "Mở buổi chơi",
    }),
  });
}

export async function sendPaymentDueNotification(env: Env, input: PaymentNotificationInput) {
  const sessionUrl = normalizeUrl(env.FRONTEND_URL, `/sessions/${input.sessionId}`);
  const total = input.lines.reduce((sum, item) => sum + item.amount, 0);

  await sendMail(env, {
    to: input.debtorEmail,
    subject: `Bạn có khoản cần thanh toán cho buổi ${input.venue}`,
    text: [
      `Chào ${input.debtorName},`,
      "",
      `Buổi chơi ${input.venue} ngày ${formatDate(input.date)} lúc ${input.startTime} đã được cập nhật công nợ.`,
      "",
      ...input.lines.map((item) => `- Trả cho ${item.recipientName}: ${formatCurrency(item.amount)}`),
      "",
      `Tổng cần chuyển: ${formatCurrency(total)}`,
      `Xem chi tiết: ${sessionUrl}`,
    ].join("\n"),
    html: renderEmailShell({
      preheader: `Bạn có ${formatCurrency(total)} cần thanh toán cho buổi ${input.venue}.`,
      title: "Có khoản thanh toán mới",
      intro: `Buổi chơi ${input.venue} ngày ${formatDate(input.date)} lúc ${input.startTime} đã được cập nhật công nợ cho bạn.`,
      facts: [
        { label: "Người nhận", value: input.lines.map((item) => item.recipientName).join(", ") },
        { label: "Tổng cần chuyển", value: formatCurrency(total) },
      ],
      htmlBlocks: [
        `<div style="margin-top: 16px; padding: 16px; border-radius: 14px; background: #f9fafb;">
          <div style="margin: 0 0 10px; color: #111827; font-size: 14px; font-weight: 700;">Chi tiết các khoản cần trả</div>
          ${input.lines.map((item) => `
            <div style="display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid #e5e7eb;">
              <span style="color: #374151; font-size: 14px;">Trả cho ${escapeHtml(item.recipientName)}</span>
              <strong style="color: #111827; font-size: 14px;">${escapeHtml(formatCurrency(item.amount))}</strong>
            </div>
          `).join("")}
        </div>`,
      ],
      ctaHref: sessionUrl,
      ctaLabel: "Xem công nợ",
      footerNote: "Nếu bạn đã thanh toán, trạng thái trong ứng dụng sẽ được cập nhật khi người quản lý xác nhận.",
    }),
  });
}

export async function sendPaymentReceivedNotification(env: Env, input: PaymentReceivedNotificationInput) {
  const sessionUrl = normalizeUrl(env.FRONTEND_URL, `/sessions/${input.sessionId}`);
  const paidAt = formatDateTime(input.paidAt);

  await sendMail(env, {
    to: input.debtorEmail,
    subject: `Bên nhận đã xác nhận thanh toán ${formatCurrency(input.amount)}`,
    text: [
      `Chào ${input.debtorName},`,
      "",
      `${input.recipientName} đã xác nhận đã nhận khoản thanh toán của bạn cho buổi chơi ${input.venue}.`,
      "",
      `Số tiền: ${formatCurrency(input.amount)}`,
      `Buổi chơi: ${input.venue} - ${formatDate(input.date)} lúc ${input.startTime}`,
      paidAt ? `Thời điểm xác nhận: ${paidAt}` : "",
      "",
      `Xem chi tiết: ${sessionUrl}`,
    ].filter(Boolean).join("\n"),
    html: renderEmailShell({
      preheader: `${input.recipientName} đã xác nhận đã nhận ${formatCurrency(input.amount)}.`,
      title: "Thanh toán đã được xác nhận",
      intro: `${input.recipientName} đã xác nhận đã nhận khoản thanh toán của bạn cho buổi chơi ${input.venue}.`,
      facts: [
        { label: "Người nhận", value: input.recipientName },
        { label: "Số tiền", value: formatCurrency(input.amount) },
        { label: "Buổi chơi", value: `${input.venue} - ${formatDate(input.date)} lúc ${input.startTime}` },
        ...(paidAt ? [{ label: "Xác nhận lúc", value: paidAt }] : []),
      ],
      ctaHref: sessionUrl,
      ctaLabel: "Xem thanh toán",
      footerNote: "Email này xác nhận phía nhận tiền đã đánh dấu khoản thanh toán là hoàn tất trong ứng dụng.",
    }),
  });
}

export async function sendPaymentMarkedPaidNotification(env: Env, input: PaymentMarkedPaidNotificationInput) {
  const sessionUrl = normalizeUrl(env.FRONTEND_URL, `/sessions/${input.sessionId}`);
  const markedAt = formatDateTime(input.markedAt);

  await sendMail(env, {
    to: input.recipientEmail,
    subject: `${input.debtorName} đã đánh dấu đã trả ${formatCurrency(input.amount)}`,
    text: [
      `Chào ${input.recipientName},`,
      "",
      `${input.debtorName} đã đánh dấu đã trả khoản thanh toán cho bạn trong buổi chơi ${input.venue}.`,
      "",
      `Số tiền: ${formatCurrency(input.amount)}`,
      `Buổi chơi: ${input.venue} - ${formatDate(input.date)} lúc ${input.startTime}`,
      markedAt ? `Thời điểm báo đã trả: ${markedAt}` : "",
      "",
      "Khi bạn đã nhận tiền, hãy mở ứng dụng và bấm xác nhận đã nhận để hoàn tất giao dịch.",
      `Xem chi tiết: ${sessionUrl}`,
    ].filter(Boolean).join("\n"),
    html: renderEmailShell({
      preheader: `${input.debtorName} đã báo đã trả ${formatCurrency(input.amount)} cho bạn.`,
      title: "Có khoản thanh toán chờ xác nhận",
      intro: `${input.debtorName} đã đánh dấu đã trả khoản thanh toán cho bạn. Giao dịch chỉ hoàn tất sau khi bạn xác nhận đã nhận tiền.`,
      facts: [
        { label: "Người trả", value: input.debtorName },
        { label: "Số tiền", value: formatCurrency(input.amount) },
        { label: "Buổi chơi", value: `${input.venue} - ${formatDate(input.date)} lúc ${input.startTime}` },
        ...(markedAt ? [{ label: "Báo đã trả lúc", value: markedAt }] : []),
      ],
      ctaHref: sessionUrl,
      ctaLabel: "Xác nhận đã nhận",
      footerNote: "Chỉ xác nhận khi bạn đã thật sự nhận được tiền.",
    }),
  });
}

export async function sendGroupInviteNotification(env: Env, input: GroupInviteNotificationInput) {
  const membersUrl = normalizeUrl(env.FRONTEND_URL, "/members");
  const inviteRole = input.role === "admin" ? "quản trị viên" : "thành viên";
  const recipientName = input.invitedName?.trim() || "bạn";

  await sendMail(env, {
    to: input.invitedEmail,
    subject: `Bạn được mời vào nhóm ${input.groupName}`,
    text: [
      `Chào ${recipientName},`,
      "",
      `${input.invitedByName} đã mời bạn vào nhóm ${input.groupName} với vai trò ${inviteRole}.`,
      input.groupDescription ? `Mô tả nhóm: ${input.groupDescription}` : "",
      "",
      `Xem lời mời tại: ${membersUrl}`,
    ].filter(Boolean).join("\n"),
    html: renderEmailShell({
      preheader: `Bạn vừa nhận được lời mời vào nhóm ${input.groupName}.`,
      title: "Bạn có lời mời vào nhóm",
      intro: `${input.invitedByName} đã mời bạn vào nhóm ${input.groupName}. Bạn có thể mở ứng dụng để chấp nhận hoặc từ chối lời mời.`,
      facts: [
        { label: "Vai trò", value: inviteRole },
        { label: "Người mời", value: input.invitedByName },
      ],
      htmlBlocks: input.groupDescription ? [
        `<div style="margin-top: 12px; padding: 14px 16px; border-radius: 12px; background: #f9fafb; color: #374151; font-size: 14px; line-height: 1.7;">
          <strong style="color: #111827;">Mô tả nhóm:</strong><br />
          ${escapeHtml(input.groupDescription)}
        </div>`,
      ] : [],
      ctaHref: membersUrl,
      ctaLabel: "Xem lời mời",
    }),
  });
}
