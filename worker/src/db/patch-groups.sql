CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE members ADD COLUMN group_id TEXT;
ALTER TABLE sessions ADD COLUMN group_id TEXT;
ALTER TABLE sessions ADD COLUMN created_by TEXT;

INSERT OR IGNORE INTO groups (id, name, description, owner_user_id, created_at, updated_at)
SELECT
  'default',
  'Hội cầu lông',
  'Nhóm mặc định cho dữ liệu hiện tại',
  id,
  datetime('now'),
  datetime('now')
FROM users
ORDER BY CASE WHEN email = 'tranthanhhung1641@gmail.com' THEN 0 ELSE 1 END, created_at
LIMIT 1;

INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
SELECT
  'default',
  id,
  CASE WHEN role = 'admin' OR email = 'tranthanhhung1641@gmail.com' THEN 'admin' ELSE 'member' END,
  datetime('now')
FROM users
WHERE EXISTS (SELECT 1 FROM groups WHERE id = 'default');

UPDATE sessions SET group_id = 'default' WHERE group_id IS NULL AND EXISTS (SELECT 1 FROM groups WHERE id = 'default');
UPDATE members SET group_id = 'default' WHERE group_id IS NULL AND EXISTS (SELECT 1 FROM groups WHERE id = 'default');

CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_members_group_id ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
