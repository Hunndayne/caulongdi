-- Theo dõi việc hũ hoàn lại tiền cho người ứng chi phí (buổi thu về tài khoản chung nhóm).
--
-- Cố tình KHÔNG dùng bảng payments: payments được cộng dồn ở rất nhiều chỗ (tổng buổi,
-- thống kê, bot), thêm dòng ngược chiều vào đó sẽ làm sai mọi con số. Ngoài ra hũ không thể
-- là bên nợ trong payments vì cột member_id là NOT NULL.
--
-- Hai bước giống nếp payments sẵn có: người rút quỹ đánh dấu đã chuyển (transferred_at),
-- người ứng tiền xác nhận đã nhận (confirmed_at).
CREATE TABLE IF NOT EXISTS pot_paybacks (
  session_id     TEXT NOT NULL,
  member_id      TEXT NOT NULL,          -- người đã ứng chi phí, nhận lại tiền từ hũ
  amount         REAL NOT NULL,          -- số tiền tại lúc đánh dấu, để phát hiện lệch khi chi phí đổi
  transferred_at TEXT,
  transferred_by TEXT,                   -- user id người bấm đã chuyển
  confirmed_at   TEXT,
  PRIMARY KEY (session_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_pot_paybacks_session ON pot_paybacks(session_id);
