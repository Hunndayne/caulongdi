-- Lưu danh sách co-managers (JSON array of user_ids, vd: '["userId1","userId2"]')
ALTER TABLE sessions ADD COLUMN managers TEXT;
