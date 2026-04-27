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

type GroupInviteNotificationInput = {
  groupName: string;
  groupDescription?: string | null;
  invitedName?: string | null;
  invitedEmail: string;
  invitedByName: string;
  role: "admin" | "member";
};

const SMTP_OK_CODES = new Set([220, 235, 250, 251, 334, 354, 221]);

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

function buildMimeMessage(env: Env, message: MailMessage) {
  const senderEmail = env.SMTP_FROM_EMAIL || env.SMTP_LOGIN;
  const senderName = env.SMTP_FROM_NAME || "Hội cầu lông";
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  const toHeader = recipients.length === 1 ? formatAddress(recipients[0]) : "undisclosed-recipients:;";
  const boundary = `cf-worker-${crypto.randomUUID()}`;

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
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    parts.join("\r\n"),
  ].join("\r\n");
}

class SmtpClient {
  private socket: ReturnType<typeof connect>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buffer = "";

  private constructor(socket: Socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async connect(env: Env) {
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
    const heloHost = new URL(env.FRONTEND_URL).hostname || "localhost";

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
        const code = Number(nextLine.slice(0, 3));
        const message = lines.join("\n");
        if (!SMTP_OK_CODES.has(code) && lines.length === 1) {
          return { code, message };
        }
        return { code, message };
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

  const client = await SmtpClient.connect(env);
  try {
    await client.sendMail(env, message);
  } finally {
    await client.close();
  }
}

export async function sendNewSessionNotification(env: Env, input: SessionNotificationInput) {
  if (input.recipients.length === 0) return;

  const sessionUrl = normalizeUrl(env.FRONTEND_URL, `/sessions/${input.sessionId}`);
  const locationLine = input.location ? `Địa điểm: ${input.location}` : "";
  const noteLine = input.note ? `Ghi chú: ${input.note}` : "";
  const detailLines = [locationLine, noteLine].filter(Boolean).join("\n");

  await sendMail(env, {
    to: input.recipients,
    subject: `Lịch chơi mới trong nhóm ${input.groupName}`,
    text: [
      `Nhóm ${input.groupName} vừa có lịch chơi mới.`,
      "",
      `Người tạo: ${input.creatorName}`,
      `Sân: ${input.venue}`,
      `Thời gian: ${formatDate(input.date)} lúc ${input.startTime}`,
      detailLines,
      "",
      `Xem chi tiết: ${sessionUrl}`,
    ].filter(Boolean).join("\n"),
    html: [
      `<p>Nhóm <strong>${escapeHtml(input.groupName)}</strong> vừa có lịch chơi mới.</p>`,
      "<ul>",
      `<li>Người tạo: ${escapeHtml(input.creatorName)}</li>`,
      `<li>Sân: ${escapeHtml(input.venue)}</li>`,
      `<li>Thời gian: ${escapeHtml(formatDate(input.date))} lúc ${escapeHtml(input.startTime)}</li>`,
      input.location ? `<li>Địa điểm: ${escapeHtml(input.location)}</li>` : "",
      input.note ? `<li>Ghi chú: ${escapeHtml(input.note)}</li>` : "",
      "</ul>",
      `<p><a href="${escapeHtml(sessionUrl)}">Mở buổi chơi</a></p>`,
    ].join(""),
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
    html: [
      `<p>Chào ${escapeHtml(input.debtorName)},</p>`,
      `<p>Buổi chơi <strong>${escapeHtml(input.venue)}</strong> ngày ${escapeHtml(formatDate(input.date))} lúc ${escapeHtml(input.startTime)} đã được cập nhật công nợ.</p>`,
      "<ul>",
      ...input.lines.map((item) => `<li>Trả cho ${escapeHtml(item.recipientName)}: ${escapeHtml(formatCurrency(item.amount))}</li>`),
      "</ul>",
      `<p><strong>Tổng cần chuyển: ${escapeHtml(formatCurrency(total))}</strong></p>`,
      `<p><a href="${escapeHtml(sessionUrl)}">Mở buổi chơi để xem chi tiết</a></p>`,
    ].join(""),
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
    html: [
      `<p>Chào ${escapeHtml(recipientName)},</p>`,
      `<p><strong>${escapeHtml(input.invitedByName)}</strong> đã mời bạn vào nhóm <strong>${escapeHtml(input.groupName)}</strong> với vai trò ${escapeHtml(inviteRole)}.</p>`,
      input.groupDescription ? `<p>Mô tả nhóm: ${escapeHtml(input.groupDescription)}</p>` : "",
      `<p><a href="${escapeHtml(membersUrl)}">Mở trang thành viên để xem lời mời</a></p>`,
    ].join(""),
  });
}
