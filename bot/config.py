"""Cấu hình bot — đọc từ .env (xem .env.example)."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


def _require(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Thiếu biến môi trường {name} — xem .env.example")
    return value


WORKER_URL = _require("WORKER_URL").rstrip("/")
BOT_MESSAGE_ENDPOINT = f"{WORKER_URL}/api/bot/message"
BOT_SERVICE_SECRET = _require("BOT_SERVICE_SECRET")

# Một hoặc nhiều group chat: THREAD_IDS="id1,id2" (ưu tiên) hoặc THREAD_ID="id" (cũ).
# Mỗi thread là một tab Chromium — server RAM thấp chỉ nên 2-3 thread.
_raw_threads = os.getenv("THREAD_IDS", "").strip() or _require("THREAD_ID")
THREAD_IDS = [x.strip() for x in _raw_threads.split(",") if x.strip()]
THREAD_ID = THREAD_IDS[0]  # tương thích chỗ cũ (/send mặc định, log)

BOT_NAME = os.getenv("BOT_NAME", "TingTing").strip()
STORAGE_STATE = str(Path(__file__).parent / os.getenv("STORAGE_STATE", "storage_state.json"))
HEADLESS = os.getenv("HEADLESS", "true").strip().lower() != "false"
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "4"))
RESTART_HOURS = float(os.getenv("RESTART_HOURS", "8"))
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "8090"))

def thread_url(thread_id: str) -> str:
    return f"https://www.messenger.com/t/{thread_id}"


THREAD_URL = thread_url(THREAD_ID)  # tương thích cũ
