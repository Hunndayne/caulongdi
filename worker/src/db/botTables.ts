// Tạo bảng liên kết bot/Messenger nếu chưa có (phòng khi patch chưa chạy trên môi trường đó).
// Idempotent, guard bằng cờ module để không gọi lại mỗi request.

let ensured = false;

export async function ensureBotTables(db: D1Database) {
  if (ensured) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bot_thread_links (
        thread_id TEXT PRIMARY KEY,
        group_id  TEXT NOT NULL UNIQUE,
        linked_by TEXT,
        linked_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bot_link_codes (
        code       TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL,
        issued_by  TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_bot_link_codes_group ON bot_link_codes(group_id)")
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_bot_link_codes_expires ON bot_link_codes(expires_at)")
    .run();

  // Hàng đợi tin bot chủ động gửi (nhắc kèo, báo kèo mới...) — bot Python poll rồi ACK.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bot_outbox (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL,
        text       TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        sent_at    TEXT
      )`
    )
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_bot_outbox_unsent ON bot_outbox(thread_id, sent_at)")
    .run();

  // Ghép tên hiển thị Messenger ↔ thành viên web (lệnh /alias) — theo từng thread.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bot_sender_aliases (
        thread_id   TEXT NOT NULL,
        sender_norm TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        member_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (thread_id, sender_norm)
      )`
    )
    .run();

  // Tóm tắt context nhóm (dùng chung với web chat).
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS group_chat_summaries (
        group_id        TEXT PRIMARY KEY,
        summary         TEXT NOT NULL DEFAULT '',
        human_summary   TEXT NOT NULL DEFAULT '',
        group_style     TEXT NOT NULL DEFAULT '',
        last_message_id TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        generated_at    TEXT NOT NULL
      )`
    )
    .run();

  // DB đã tồn tại từ trước sẽ thiếu cột human_summary — thêm idempotent (bỏ qua lỗi trùng cột).
  await ensureColumn(db, "group_chat_summaries", "human_summary");

  // Nhắc công nợ định kỳ vào group chat — trưởng nhóm bật/tắt và chọn giờ trong Cài đặt nhóm.
  // Mặc định TẮT: nhóm đang dùng không tự dưng bị bot nhắc nợ sau khi deploy.
  await ensureColumn(db, "groups", "debt_reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "groups", "debt_reminder_time", "TEXT");
  // Chu kỳ nhắc (patch-debt-reminder-cycle.sql). NULL = 'daily' — nhóm cũ giữ nguyên nhịp hằng ngày.
  await ensureColumn(db, "groups", "debt_reminder_cycle", "TEXT");
  await ensureColumn(db, "groups", "debt_reminder_interval_days", "INTEGER");
  await ensureColumn(db, "groups", "debt_reminder_weekday", "INTEGER");
  await ensureColumn(db, "groups", "debt_reminder_anchor_date", "TEXT");

  // Chatbot chạy bằng AI agent (tool-calling) thay cho phân loại intent cứng — bật/tắt theo từng
  // nhóm trong Cài đặt nhóm. Mặc định TẮT: nhóm đang chạy vẫn dùng luồng cũ tới khi tự bật.
  await ensureColumn(db, "groups", "bot_agent_enabled", "INTEGER NOT NULL DEFAULT 0");

  ensured = true;
}

// Thêm cột nếu chưa có. Bỏ qua lỗi "duplicate column".
async function ensureColumn(db: D1Database, table: string, column: string, type = "TEXT NOT NULL DEFAULT ''") {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Cột đã tồn tại — không sao.
  }
}
