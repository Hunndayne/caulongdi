-- Thêm cột payer_id: ai bỏ tiền trả hộ; NULL = quỹ chung trả
ALTER TABLE costs ADD COLUMN payer_id TEXT REFERENCES members(id) ON DELETE SET NULL;

-- Thêm cột consumer_id: ai dùng riêng; NULL = chia đều tất cả attendees
ALTER TABLE costs ADD COLUMN consumer_id TEXT REFERENCES members(id) ON DELETE CASCADE;
