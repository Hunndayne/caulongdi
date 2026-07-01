-- Lịch sử tin nhắn Messenger — lưu tạm trong D1 để build context bền qua các lần restart.

CREATE TABLE IF NOT EXISTS bot_thread_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  group_id    TEXT,
  sender_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user',
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_thread_messages ON bot_thread_messages(thread_id, created_at);
