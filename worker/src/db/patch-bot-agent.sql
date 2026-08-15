-- Chatbot chạy bằng AI agent (tool-calling DeepSeek) thay cho phân loại intent cứng.
-- Bật/tắt theo TỪNG NHÓM trong Cài đặt nhóm (groups.bot_agent_enabled), không dùng env toàn hệ thống.
--
-- Mặc định TẮT: nhóm đang chạy vẫn giữ luồng intent cũ sau khi deploy, tới khi trưởng nhóm tự bật.
-- Bot cũng tự thêm cột này lúc chạy (ensureBotTables) nên migration chỉ để chuẩn hoá schema.
ALTER TABLE groups ADD COLUMN bot_agent_enabled INTEGER NOT NULL DEFAULT 0;
