-- Lưu người nhận tiền cho session (giá trị: "auto_<memberId>" hoặc "<memberId>")
ALTER TABLE sessions ADD COLUMN payment_recipient TEXT;
