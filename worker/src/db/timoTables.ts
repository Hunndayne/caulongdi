// Cài đặt thanh toán của nhóm (tài khoản nhận chung + hũ Timo tuỳ chọn)
// và bảng chống xử lý trùng giao dịch.
// Idempotent, guard bằng cờ module để không gọi lại mỗi request (giống ensureBotTables).

let ensured = false;

const GROUP_COLUMNS = [
  "group_bank_bin",
  "group_bank_account_number",
  "group_bank_account_name",
  "timo_verify_code",
  "timo_security_hash",
  "timo_pot_name",
  "timo_pot_account",
  "timo_pot_alt_account",
  "timo_pot_bank_label",
  "timo_owner_name",
  "timo_last_checked_at",
  "timo_last_ok_at",
  "timo_last_error",
];

export async function ensureTimoPotTables(db: D1Database) {
  if (ensured) return;

  for (const column of GROUP_COLUMNS) {
    await ensureColumn(db, "groups", column);
  }

  // Mỗi buổi chọn thu về hũ nhóm hay về người nhận chung.
  await ensureColumn(db, "sessions", "payment_to_pot", "INTEGER NOT NULL DEFAULT 0");

  // Giao dịch Timo KHÔNG có id/refNo → dedupe bằng fingerprint
  // sha256(dispDate|txnAmount|remainingAmount|txnDesc).
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS timo_seen_txn (
        group_id         TEXT NOT NULL,
        fingerprint      TEXT NOT NULL,
        txn_date         TEXT,
        amount           REAL,
        remaining_amount REAL,
        txn_title        TEXT,
        txn_desc         TEXT,
        from_timo_bank   INTEGER,
        payment_id       TEXT,
        outcome          TEXT NOT NULL,
        seen_at          TEXT NOT NULL,
        PRIMARY KEY (group_id, fingerprint)
      )`
    )
    .run();

  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_timo_seen_group_seen ON timo_seen_txn(group_id, seen_at)")
    .run();

  ensured = true;
}

// Thêm cột nếu chưa có (mặc định TEXT nullable). Bỏ qua lỗi "duplicate column".
async function ensureColumn(db: D1Database, table: string, column: string, type = "TEXT") {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Cột đã tồn tại — không sao.
  }
}
