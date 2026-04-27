CREATE TABLE IF NOT EXISTS group_invite_links (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_invite_links_code ON group_invite_links(code);
CREATE INDEX IF NOT EXISTS idx_group_invite_links_group_id ON group_invite_links(group_id);
