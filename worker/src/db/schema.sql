CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  phone TEXT,
  bio TEXT,
  birthday TEXT,
  location TEXT,
  bank_bin TEXT,
  bank_account_number TEXT,
  bank_account_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions_auth (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

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

CREATE TABLE IF NOT EXISTS group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  invited_user_id TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE (group_id, invited_user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  user_id TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#22c55e',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  created_by TEXT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  venue TEXT NOT NULL,
  location TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  payment_recipient TEXT,
  managers TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  attended INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, member_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS costs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  payer_id TEXT,                          -- ai trả tiền hộ; NULL = quỹ chung trả
  consumer_id TEXT,                       -- ai dùng riêng; NULL = chia đều cho tất cả
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (payer_id) REFERENCES members(id) ON DELETE SET NULL,
  FOREIGN KEY (consumer_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_owed REAL NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_user_id ON group_invites(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_group_id ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_members_group_id ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
