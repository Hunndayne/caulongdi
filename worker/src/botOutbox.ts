// Outbox: kênh để Worker chủ động nhắn vào group chat Messenger.
// Worker không gọi vào được server bot (DDNS/NAT) nên chỉ ghi hàng đợi;
// bot Python poll GET /api/bot/outbox mỗi vòng rồi ACK sau khi gửi.
// Tách module riêng (không import từ routes/) để sessions.ts lẫn bot.ts dùng được mà không vòng import.

import { Env } from "./types";
import { ensureBotTables } from "./db/botTables";

const REMIND_AHEAD_HOURS = 3;
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
  venue: string;
  location: string | null;
  group_id: string;
  attendee_count: number;
  attendee_names: string | null;
};

/** Cron: nhắc các kèo sắp diễn ra trong REMIND_AHEAD_HOURS tới (dedupe theo session). */
export async function enqueueSessionReminders(env: Env): Promise<number> {
  await ensureBotTables(env.DB);

  // Dọn tin đã gửi quá hạn giữ — tiện tay mỗi lần cron chạy.
  const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM bot_outbox WHERE sent_at IS NOT NULL AND created_at < ?").bind(cutoff).run();

  const now = vnNowDate();
  const today = now.toISOString().slice(0, 10);
  const nowHM = now.toISOString().slice(11, 16);
  const aheadHM = new Date(now.getTime() + REMIND_AHEAD_HOURS * 60 * 60 * 1000).toISOString().slice(11, 16);
  // Cửa sổ vắt qua nửa đêm thì cắt ở cuối ngày — kèo sáng mai sẽ tới lượt ở cron sáng.
  const endHM = aheadHM < nowHM ? "23:59" : aheadHM;

  const rows = await env.DB.prepare(
    `SELECT s.id, s.date, s.start_time, s.venue, s.location, s.group_id,
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
    const lines = [`⏰ Nhắc kèo hôm nay (${formatDateVn(s.date)}): ${s.start_time} tại ${s.venue}`];
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

/** Báo lên chat khi có kèo mới tạo từ web (dedupe theo session). */
export async function enqueueNewSessionAnnounce(
  env: Env,
  groupId: string,
  session: { id: string; date: string; startTime: string; venue: string; location?: string | null }
): Promise<boolean> {
  const lines = [
    "🆕 Kèo mới vừa tạo trên web:",
    `🏸 ${formatDateVn(session.date)} • ${session.startTime} • ${session.venue}`,
  ];
  if (session.location) lines.push(`📍 ${session.location}`);
  lines.push('Ai đi thì nhắn "thêm tôi vào buổi" nhé!');
  return enqueueBotMessage(env, groupId, lines.join("\n"), `new-session:${session.id}`);
}
