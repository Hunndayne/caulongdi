"""Lưu lịch sử chat Messenger vào SQLite cục bộ — không đẩy lên D1."""

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config

_DB_PATH: str = getattr(config, "CHAT_DB_PATH", str(Path(__file__).parent / "chat_history.db"))

CONTEXT_LIMIT = 20
CONTEXT_WINDOW_MINUTES = 60
SUMMARY_THRESHOLD = 15   # số tin tích lũy để kích hoạt tóm tắt
SUMMARY_BATCH = 60       # tin nhắn gửi lên Worker để tóm tắt
KEEP_AFTER_PRUNE = 20    # giữ lại sau khi xóa tin cũ

_db: sqlite3.Connection | None = None


def _conn() -> sqlite3.Connection:
    global _db
    if _db is None:
        _db = sqlite3.connect(_DB_PATH, check_same_thread=False)
        _db.row_factory = sqlite3.Row
    return _db


def ensure_tables() -> None:
    conn = _conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id   TEXT NOT NULL,
            sender_name TEXT,
            role        TEXT NOT NULL DEFAULT 'user',
            body        TEXT NOT NULL,
            created_at  TEXT NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_msg_thread_created ON messages(thread_id, created_at)"
    )
    conn.commit()


def store_message(thread_id: str, sender_name: str | None, role: str, body: str) -> int:
    conn = _conn()
    created_at = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO messages (thread_id, sender_name, role, body, created_at) VALUES (?, ?, ?, ?, ?)",
        (thread_id, sender_name, role, body[:2000], created_at),
    )
    conn.commit()
    return cur.lastrowid or 0


def get_context(
    thread_id: str,
    limit: int = CONTEXT_LIMIT,
    window_minutes: int = CONTEXT_WINDOW_MINUTES,
) -> list[dict]:
    """Trả về [{role, text, userName?}] để gửi kèm lên Worker."""
    conn = _conn()
    since = (datetime.now(timezone.utc) - timedelta(minutes=window_minutes)).isoformat()
    rows = conn.execute(
        """SELECT sender_name, role, body FROM messages
           WHERE thread_id = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT ?""",
        (thread_id, since, limit),
    ).fetchall()
    result = []
    for r in reversed(rows):
        item: dict = {"role": r["role"], "text": r["body"]}
        if r["role"] != "assistant" and r["sender_name"]:
            item["userName"] = r["sender_name"]
        result.append(item)
    return result


def count_messages(thread_id: str) -> int:
    conn = _conn()
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", (thread_id,)
    ).fetchone()
    return int(row["n"]) if row else 0


def get_batch_for_summary(thread_id: str, limit: int = SUMMARY_BATCH) -> list[dict]:
    """Lấy batch tin mới nhất để gửi lên Worker tóm tắt."""
    conn = _conn()
    rows = conn.execute(
        """SELECT sender_name, role, body FROM messages
           WHERE thread_id = ?
           ORDER BY created_at DESC LIMIT ?""",
        (thread_id, limit),
    ).fetchall()
    return [
        {"senderName": r["sender_name"], "role": r["role"], "body": r["body"]}
        for r in reversed(rows)
    ]


def prune_old_messages(thread_id: str, keep_recent: int = KEEP_AFTER_PRUNE) -> int:
    """Xóa tin cũ, giữ keep_recent tin gần nhất. Trả về số dòng đã xóa."""
    conn = _conn()
    rows = conn.execute(
        "SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
        (thread_id, keep_recent),
    ).fetchall()
    if len(rows) < keep_recent:
        return 0
    cutoff_id = rows[-1]["id"]
    cur = conn.execute(
        "DELETE FROM messages WHERE thread_id = ? AND id < ?",
        (thread_id, cutoff_id),
    )
    conn.commit()
    return cur.rowcount
