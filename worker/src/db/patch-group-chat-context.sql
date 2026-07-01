-- Lưu tóm tắt context nhóm do AI tổng hợp từ lịch sử chat.
-- Cập nhật sau mỗi TING_SUMMARY_UPDATE_THRESHOLD tin mới.

CREATE TABLE IF NOT EXISTS group_chat_summaries (
  group_id       TEXT PRIMARY KEY,
  summary        TEXT NOT NULL DEFAULT '',
  group_style    TEXT NOT NULL DEFAULT '',
  last_message_id TEXT,
  message_count  INTEGER NOT NULL DEFAULT 0,
  generated_at   TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);
