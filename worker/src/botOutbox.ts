// Outbox: kênh để Worker chủ động nhắn vào group chat Messenger.
// Worker không gọi vào được server bot (DDNS/NAT) nên chỉ ghi hàng đợi;
// bot Python poll GET /api/bot/outbox mỗi vòng rồi ACK sau khi gửi.
// Tách module riêng (không import từ routes/) để sessions.ts lẫn bot.ts dùng được mà không vòng import.

import { Env } from "./types";
import { ensureBotTables } from "./db/botTables";

// Cron chạy mỗi 10' (wrangler.toml); cửa sổ 40' + dedupe ⇒ tin nhắc đến tay
// khoảng 30–40 phút trước giờ chơi.
const REMIND_AHEAD_MINUTES = 40;
const OUTBOX_RETENTION_DAYS = 7;

function vnNowDate() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function formatDateVn(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

/** Ghi một tin vào outbox của thread đang liên kết với nhóm. Trả về true nếu có ghi (false: nhóm chưa liên kết / trùng dedupe). */
export async function enqueueBotMessage(
  env: Env,
  groupId: string,
  text: string,
  dedupeKey?: string
): Promise<boolean> {
  await ensureBotTables(env.DB);
  const link = await env.DB.prepare("SELECT thread_id FROM bot_thread_links WHERE group_id = ?")
    .bind(groupId)
    .first<{ thread_id: string }>();
  if (!link) return false;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO bot_outbox (id, thread_id, text, dedupe_key, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(crypto.randomUUID(), link.thread_id, text.slice(0, 1600), dedupeKey ?? null, new Date().toISOString())
    .run();
  return Boolean(result.meta?.changes);
}

type ReminderRow = {
  id: string;
  date: string;
  start_time: string;
  end_time?: string | null;
  name?: string | null;
  venue: string;
  location: string | null;
  group_id: string;
  attendee_count: number;
  attendee_names: string | null;
};

function sessionTitle(session: { name?: string | null; venue: string }) {
  return session.name?.trim() || session.venue;
}

function timeRange(session: { start_time?: string; startTime?: string; end_time?: string | null; endTime?: string | null }) {
  const start = session.start_time ?? session.startTime ?? "";
  const end = session.end_time ?? session.endTime;
  return end ? `${start}-${end}` : start;
}

/** Cron: nhắc các kèo sắp diễn ra trong REMIND_AHEAD_MINUTES tới (dedupe theo session). */
export async function enqueueSessionReminders(env: Env): Promise<number> {
  await ensureBotTables(env.DB);

  // Dọn tin đã gửi quá hạn giữ — tiện tay mỗi lần cron chạy.
  const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM bot_outbox WHERE sent_at IS NOT NULL AND created_at < ?").bind(cutoff).run();

  const now = vnNowDate();
  const today = now.toISOString().slice(0, 10);
  const nowHM = now.toISOString().slice(11, 16);
  const aheadHM = new Date(now.getTime() + REMIND_AHEAD_MINUTES * 60 * 1000).toISOString().slice(11, 16);
  // Cửa sổ vắt qua nửa đêm thì cắt ở cuối ngày — kèo sáng mai sẽ tới lượt ở cron sáng.
  const endHM = aheadHM < nowHM ? "23:59" : aheadHM;

  const rows = await env.DB.prepare(
    `SELECT s.id, s.date, s.start_time, s.end_time, s.name, s.venue, s.location, s.group_id,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_count,
      (SELECT group_concat(m.name, ', ') FROM session_members sm JOIN members m ON m.id = sm.member_id
        WHERE sm.session_id = s.id AND sm.attended = 1) AS attendee_names
     FROM sessions s
     JOIN bot_thread_links l ON l.group_id = s.group_id
     WHERE s.status = 'upcoming' AND s.date = ? AND s.start_time >= ? AND s.start_time <= ?`
  )
    .bind(today, nowHM, endHM)
    .all<ReminderRow>();

  let queued = 0;
  for (const s of rows.results ?? []) {
    const lines = [`⏰ Sắp tới giờ chơi: ${timeRange(s)} hôm nay - ${sessionTitle(s)}`];
    lines.push(`🏸 ${s.venue}`);
    if (s.location) lines.push(`📍 ${s.location}`);
    lines.push(
      s.attendee_count > 0
        ? `👥 ${s.attendee_count} người: ${s.attendee_names}`
        : '👥 Chưa ai xác nhận — nhắn "thêm tôi vào buổi" nhé!'
    );
    if (await enqueueBotMessage(env, s.group_id, lines.join("\n"), `reminder:${s.id}`)) queued += 1;
  }
  return queued;
}

// --- Nhắc công nợ định kỳ ---

const DEBT_REMINDER_DEFAULT_TIME = "20:00";
// Cron chạy 10'/lần; cửa sổ 30' cho cron lỡ nhịp vẫn kịp, dedupe theo ngày lo phần chỉ gửi 1 lần.
const DEBT_REMINDER_WINDOW_MINUTES = 30;

type DebtGroupRow = { id: string; name: string; debt_reminder_time: string | null };

type MemberDebtRow = {
  member_name: string;
  total: number;
  session_count: number;
  marked_count: number;
};

function formatMoneyVn(amount: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Math.round(Number(amount) || 0));
}

/** "HH:MM" hợp lệ thì trả lại, không thì dùng mặc định. */
function normalizeReminderTime(value: string | null): string {
  const t = (value ?? "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : DEBT_REMINDER_DEFAULT_TIME;
}

/**
 * Cron: nhắc công nợ còn lại của từng thành viên vào group chat.
 * Chỉ nhóm đã bật trong Cài đặt nhóm VÀ đã liên kết thread Messenger mới nhận.
 */
export async function enqueueDebtReminders(env: Env): Promise<number> {
  await ensureBotTables(env.DB);

  const now = vnNowDate();
  const today = now.toISOString().slice(0, 10);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  const groups = await env.DB.prepare(
    `SELECT g.id, g.name, g.debt_reminder_time
     FROM groups g
     JOIN bot_thread_links l ON l.group_id = g.id
     WHERE g.debt_reminder_enabled = 1`
  ).all<DebtGroupRow>();

  let queued = 0;
  for (const group of groups.results ?? []) {
    const [hh, mm] = normalizeReminderTime(group.debt_reminder_time).split(":");
    const targetMin = Number(hh) * 60 + Number(mm);
    // Cố tình KHÔNG cho cửa sổ vắt qua nửa đêm: giữ dedupe key gọn trong đúng một ngày.
    if (nowMin < targetMin || nowMin >= targetMin + DEBT_REMINDER_WINDOW_MINUTES) continue;

    const debts = await env.DB.prepare(
      `SELECT m.name AS member_name,
        SUM(p.amount_owed) AS total,
        COUNT(*) AS session_count,
        SUM(p.payer_marked_paid) AS marked_count
       FROM payments p
       JOIN sessions s ON s.id = p.session_id
       JOIN members m ON m.id = p.member_id
       WHERE s.group_id = ? AND p.paid = 0 AND p.amount_owed > 0
       GROUP BY p.member_id
       ORDER BY total DESC, m.name COLLATE NOCASE`
    )
      .bind(group.id)
      .all<MemberDebtRow>();

    const rows = debts.results ?? [];
    // Không ai nợ thì im lặng — nhắc "cả nhóm sạch nợ" mỗi ngày chỉ tổ gây nhiễu.
    if (!rows.length) continue;

    const lines = [`💸 Nhắc công nợ nhóm ${group.name} (${formatDateVn(today)})`, ""];
    for (const r of rows) {
      // Đã bấm "đã chuyển" hết mà bên nhận chưa xác nhận → đánh dấu để khỏi bị nhắc oan.
      const allMarked = Number(r.marked_count) >= Number(r.session_count);
      lines.push(
        `• ${r.member_name} — ${formatMoneyVn(r.total)} (${r.session_count} buổi)${
          allMarked ? " ⏳ đã báo chuyển, chờ xác nhận" : ""
        }`
      );
    }
    lines.push("", 'Chi tiết từng buổi thì nhắn "tôi còn nợ buổi nào" nhé.');

    if (await enqueueBotMessage(env, group.id, lines.join("\n"), `debt-reminder:${group.id}:${today}`)) {
      queued += 1;
    }
  }
  return queued;
}

/** Báo lên chat khi có kèo mới tạo từ web (dedupe theo session). */
export async function enqueueNewSessionAnnounce(
  env: Env,
  groupId: string,
  session: { id: string; date: string; startTime: string; endTime?: string | null; name?: string | null; venue: string; location?: string | null }
): Promise<boolean> {
  const lines = [
    "🆕 Kèo mới vừa tạo trên web:",
    `🏸 ${sessionTitle(session)}`,
    `🕒 ${formatDateVn(session.date)} • ${timeRange(session)}`,
    `Sân: ${session.venue}`,
  ];
  if (session.location) lines.push(`📍 ${session.location}`);
  lines.push('Ai đi thì nhắn "thêm tôi vào buổi" nhé!');
  return enqueueBotMessage(env, groupId, lines.join("\n"), `new-session:${session.id}`);
}
