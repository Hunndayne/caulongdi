// Bảng theo dõi hũ hoàn lại tiền cho người ứng chi phí.
// Idempotent, guard bằng cờ module để không gọi lại mỗi request (giống ensureBotTables).

let ensured = false;

export async function ensurePotPaybackTable(db: D1Database) {
  if (ensured) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pot_paybacks (
        session_id     TEXT NOT NULL,
        member_id      TEXT NOT NULL,
        amount         REAL NOT NULL,
        transferred_at TEXT,
        transferred_by TEXT,
        confirmed_at   TEXT,
        PRIMARY KEY (session_id, member_id)
      )`
    )
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_pot_paybacks_session ON pot_paybacks(session_id)")
    .run();

  ensured = true;
}
