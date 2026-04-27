ALTER TABLE payments ADD COLUMN recipient_member_id TEXT REFERENCES members(id) ON DELETE CASCADE;
