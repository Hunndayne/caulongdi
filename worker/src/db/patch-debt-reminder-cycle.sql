-- Chu kỳ nhắc công nợ: trước đây bot chỉ nhắc HẰNG NGÀY vào giờ đã đặt.
-- Bốn cột dưới cho phép trưởng nhóm chọn: hằng ngày / cách N ngày / mỗi tuần / cuối tháng.
--
-- Cột NULL = nhóm chưa đụng tới cài đặt ⇒ code hiểu là "daily", đúng hành vi cũ.
ALTER TABLE groups ADD COLUMN debt_reminder_cycle TEXT;

-- Số ngày cho chu kỳ 'every_n_days' (2..30). NULL = mặc định 3.
ALTER TABLE groups ADD COLUMN debt_reminder_interval_days INTEGER;

-- Thứ trong tuần cho chu kỳ 'weekly': 0 = Chủ nhật … 6 = Thứ 7 (theo Date.getUTCDay). NULL = Thứ 2.
ALTER TABLE groups ADD COLUMN debt_reminder_weekday INTEGER;

-- Mốc đếm kỳ của 'every_n_days', dạng "YYYY-MM-DD" giờ VN — đặt bằng ngày lưu cài đặt,
-- nhờ vậy "cách 3 ngày" tính từ hôm bật chứ không phải từ một mốc vô hình nào đó.
-- Chỉ reset khi đổi chu kỳ/số ngày, đổi mỗi giờ nhắc thì giữ nguyên nhịp.
ALTER TABLE groups ADD COLUMN debt_reminder_anchor_date TEXT;
