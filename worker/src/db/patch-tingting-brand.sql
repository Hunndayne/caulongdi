UPDATE groups
SET
  name = 'TingTing',
  updated_at = datetime('now')
WHERE name IN ('Hội cầu lông', 'Nhóm cầu lông');

