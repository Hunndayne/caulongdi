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

  // --- OAuth 2.1 cho connector web (ChatGPT/Claude.ai/Gemini web) ---
  // Client đăng ký động (RFC 7591), public client (không secret), PKCE S256 bắt buộc.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id     TEXT PRIMARY KEY,
        client_name   TEXT NOT NULL DEFAULT '',
        redirect_uris TEXT NOT NULL,            -- JSON mảng URI, khớp CHÍNH XÁC khi authorize
        created_at    TEXT NOT NULL
      )`
    )
    .run();

  // Mã uỷ quyền: dùng một lần, sống ngắn (~5 phút), gắn PKCE challenge + user + client + redirect.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
        code_hash      TEXT PRIMARY KEY,        -- sha256 của code plaintext
        client_id      TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope          TEXT NOT NULL DEFAULT 'mcp',
        resource       TEXT,
        expires_at     TEXT NOT NULL,
        consumed_at    TEXT,
        created_at     TEXT NOT NULL
      )`
    )
    .run();

  // Access/refresh token OAuth — lưu hash, thu hồi qua revoked_at.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
        access_hash  TEXT PRIMARY KEY,          -- sha256 của access token
        refresh_hash TEXT UNIQUE,               -- sha256 của refresh token (NULL nếu không cấp)
        user_id      TEXT NOT NULL,
        client_id    TEXT NOT NULL,
        scope        TEXT NOT NULL DEFAULT 'mcp',
        expires_at   TEXT NOT NULL,             -- hạn access token
        created_at   TEXT NOT NULL,
        revoked_at   TEXT
      )`
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_refresh ON mcp_oauth_tokens(refresh_hash)").run();

  ensured = true;
}
