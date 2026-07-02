-- Tách tóm tắt nhóm thành 2 bản:
--   summary       = bản ngữ cảnh CHI TIẾT cho bot đọc (đã có sẵn, nay giàu ngữ cảnh hơn)
--   human_summary = bản recap NGẮN cho người trong nhóm đọc lướt (hiển thị khi gõ /tomtat)
-- Idempotent tại runtime qua ensureBotTables/ensureChatTables; patch này dành cho DB đã tồn tại.
ALTER TABLE group_chat_summaries ADD COLUMN human_summary TEXT NOT NULL DEFAULT '';
