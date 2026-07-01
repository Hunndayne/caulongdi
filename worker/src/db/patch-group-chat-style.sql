-- Đổi từ tóm tắt phong cách TỪNG THÀNH VIÊN sang MỘT phong cách/tính cách chat
-- CHUNG của cả nhóm, để bot bắt chước tông giọng khi trả lời cho hợp không khí nhóm.
ALTER TABLE group_chat_summaries RENAME COLUMN member_styles TO group_style;
UPDATE group_chat_summaries SET group_style = '' WHERE group_style = '{}';
