-- Vãng lai (walk-in guests): chỉ tồn tại trong một buổi, không vào danh sách Hội.
-- members.is_walkin = 1 đánh dấu vãng lai; ref_member_id = người bảo lãnh (có tài khoản);
-- session_id = buổi sinh ra vãng lai (để dọn rác ephemeral).
ALTER TABLE members ADD COLUMN is_walkin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN ref_member_id TEXT;
ALTER TABLE members ADD COLUMN session_id TEXT;

-- Chế độ công nợ vãng lai theo buổi:
--   'self' = vãng lai tự nợ, ref nhận QR qua email + được đánh dấu đã trả
--   'ref'  = ref gánh gộp toàn bộ nợ của các vãng lai mình bảo lãnh
ALTER TABLE sessions ADD COLUMN walkin_debt_mode TEXT NOT NULL DEFAULT 'self';

CREATE INDEX IF NOT EXISTS idx_members_session_walkin ON members(session_id, is_walkin);
