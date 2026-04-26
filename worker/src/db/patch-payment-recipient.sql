-- Lưu người nhận tiền cho session (giá trị: "auto_<memberId>" hoặc "<memberId>")
ALTER TABLE sessions ADD COLUMN payment_recipient TEXT;
-- Lưu danh sách co-managers (JSON array of user_ids, vd: '["userId1","userId2"]')
ALTER TABLE sessions ADD COLUMN managers TEXT;
