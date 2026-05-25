-- Liên kết group chat Facebook (Messenger userbot) với nhóm TingTing.
-- bot_thread_links: 1 thread chat ↔ 1 nhóm (đã liên kết).
-- bot_link_codes:   mã OTP sinh từ web (admin nhóm), tiêu thụ trong chat qua /connect.

CREATE TABLE IF NOT EXISTS bot_thread_links (
  thread_id TEXT PRIMARY KEY,            -- id thread group chat phía Facebook
  group_id  TEXT NOT NULL UNIQUE,        -- 1 nhóm tối đa 1 thread (v1)
  linked_by TEXT,                        -- user TingTing đã tạo mã liên kết
  linked_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_link_codes (
  code       TEXT PRIMARY KEY,           -- mã 6 số
  group_id   TEXT NOT NULL,
  issued_by  TEXT NOT NULL,              -- user TingTing (admin nhóm) đã sinh mã
  expires_at TEXT NOT NULL,
  used_at    TEXT,                        -- NULL = chưa dùng
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_link_codes_group ON bot_link_codes(group_id);
CREATE INDEX IF NOT EXISTS idx_bot_link_codes_expires ON bot_link_codes(expires_at);
