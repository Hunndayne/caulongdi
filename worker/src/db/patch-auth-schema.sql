ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

ALTER TABLE sessions_auth ADD COLUMN token TEXT;
ALTER TABLE sessions_auth ADD COLUMN created_at TEXT;
ALTER TABLE sessions_auth ADD COLUMN updated_at TEXT;
ALTER TABLE sessions_auth ADD COLUMN ip_address TEXT;
ALTER TABLE sessions_auth ADD COLUMN user_agent TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_auth_token_uidx ON sessions_auth(token);
