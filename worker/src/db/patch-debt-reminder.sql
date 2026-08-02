-- Nhắc công nợ định kỳ vào group chat Messenger của nhóm.
-- Chỉ chạy cho nhóm ĐÃ liên kết thread (bot_thread_links) — nhóm chưa liên kết thì
-- enqueueBotMessage tự bỏ qua, không cần điều kiện riêng ở đây.
--
-- Mặc định TẮT: nhóm đang dùng không bị bot nhắc nợ ngay sau khi deploy.
ALTER TABLE groups ADD COLUMN debt_reminder_enabled INTEGER NOT NULL DEFAULT 0;

-- Giờ nhắc theo GIỜ VIỆT NAM, dạng "HH:MM". NULL/rỗng = dùng mặc định trong code (20:00).
-- Cron chạy 10'/lần nên tin đến trong khoảng [giờ đặt, giờ đặt + 30'), dedupe theo ngày
-- để dù cron chạy nhiều nhịp trong cửa sổ vẫn chỉ gửi đúng một lần mỗi ngày.
ALTER TABLE groups ADD COLUMN debt_reminder_time TEXT;
