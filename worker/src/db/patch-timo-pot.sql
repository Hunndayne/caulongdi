-- Cài đặt thanh toán của NHÓM: tài khoản nhận tiền chung + (tuỳ chọn) hũ Timo để tự xác nhận.
-- Trưởng nhóm tự điền toàn bộ trong Cài đặt nhóm — không hằng số nào trong code.
-- Thay cho đường Gmail Apps Script cũ (scripts/timo-gmail-webhook.gs) vốn chỉ chạy được
-- với hộp thư của một người.

-- Tài khoản nhận tiền chung của nhóm (trưởng nhóm điền). Tách biệt hoàn toàn với tài khoản
-- cá nhân trong profile — tài khoản cá nhân dùng cho chiều hoàn tiền lại người ứng chi phí.
ALTER TABLE groups ADD COLUMN group_bank_bin TEXT;
ALTER TABLE groups ADD COLUMN group_bank_account_number TEXT;
ALTER TABLE groups ADD COLUMN group_bank_account_name TEXT;

-- Hũ Timo — KHÔNG BẮT BUỘC. Có thì bật được tự xác nhận thanh toán.
ALTER TABLE groups ADD COLUMN timo_verify_code TEXT;     -- mã trong link share
ALTER TABLE groups ADD COLUMN timo_security_hash TEXT;   -- SHA-512(mật khẩu hũ) — BÍ MẬT, không trả ra API

-- Bốn cột dưới lấy từ API Timo mỗi lần lưu, chỉ để đối chiếu/hiển thị:
ALTER TABLE groups ADD COLUMN timo_pot_name TEXT;        -- sourceMoney = tên hũ
ALTER TABLE groups ADD COLUMN timo_pot_account TEXT;     -- accountNumber: SỐ RIÊNG CỦA HŨ
ALTER TABLE groups ADD COLUMN timo_pot_alt_account TEXT; -- altAccountNumber: tài khoản CHÍNH, KHÔNG phải của hũ
ALTER TABLE groups ADD COLUMN timo_pot_bank_label TEXT;  -- tên ngân hàng Timo trả về
ALTER TABLE groups ADD COLUMN timo_owner_name TEXT;      -- fullName chủ hũ

-- Sức khoẻ đối soát, hiện lên UI để lỗi không chết lặng như cách Gmail cũ.
ALTER TABLE groups ADD COLUMN timo_last_checked_at TEXT;
ALTER TABLE groups ADD COLUMN timo_last_ok_at TEXT;
ALTER TABLE groups ADD COLUMN timo_last_error TEXT;

-- Mỗi buổi tự chọn: thu về tài khoản nhóm/hũ, hay về người nhận chung.
-- Mặc định 0 = người nhận chung, giữ nguyên hành vi các buổi đang có.
ALTER TABLE sessions ADD COLUMN payment_to_pot INTEGER NOT NULL DEFAULT 0;

-- Giao dịch Timo không có id/refNo →
-- fingerprint = sha256(dispDate|txnAmount|remainingAmount|txnDesc).
-- remainingAmount (số dư sau giao dịch) nằm trong khoá để hai lần chuyển giống hệt nhau
-- không bị gộp thành một.
CREATE TABLE IF NOT EXISTS timo_seen_txn (
  group_id         TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  txn_date         TEXT,
  amount           REAL,
  remaining_amount REAL,
  txn_title        TEXT,
  txn_desc         TEXT,
  from_timo_bank   INTEGER,
  payment_id       TEXT,
  outcome          TEXT NOT NULL,
  seen_at          TEXT NOT NULL,
  PRIMARY KEY (group_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_timo_seen_group_seen ON timo_seen_txn(group_id, seen_at);
