-- Thêm thông tin ngân hàng vào bảng users
ALTER TABLE users ADD COLUMN bank_bin TEXT;            -- Mã BIN ngân hàng (vd: 970436)
ALTER TABLE users ADD COLUMN bank_account_number TEXT;  -- Số tài khoản
ALTER TABLE users ADD COLUMN bank_account_name TEXT;    -- Tên chủ tài khoản (IN HOA, KHÔNG DẤU)
