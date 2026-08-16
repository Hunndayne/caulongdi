// Bảng token MCP (kết nối app AI ngoài vào /mcp) — tạo nếu chưa có, giống ensureBotTables.
// Idempotent, guard bằng cờ module để không gọi lại mỗi request.

let ensured = false;

export async function ensureMcpTables(db: D1Database) {
  if (ensured) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mcp_tokens (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        -- NULL = token truy cập mọi nhóm mà user là thành viên (mặc định).
        group_id     TEXT,
        label        TEXT NOT NULL DEFAULT '',
        -- sha256 hex của token plaintext — không lưu plaintext bao giờ.
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      )`
    )
    .run();

  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash)").run();

  ensured = true;
}
