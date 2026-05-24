CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_date TEXT NOT NULL,
  feature TEXT NOT NULL,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, feature)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_date ON ai_usage_daily(usage_date);
