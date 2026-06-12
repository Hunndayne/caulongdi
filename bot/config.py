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
THREAD_ID = _require("THREAD_ID")

BOT_NAME = os.getenv("BOT_NAME", "TingTing").strip()
STORAGE_STATE = str(Path(__file__).parent / os.getenv("STORAGE_STATE", "storage_state.json"))
HEADLESS = os.getenv("HEADLESS", "true").strip().lower() != "false"
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "4"))
RESTART_HOURS = float(os.getenv("RESTART_HOURS", "8"))
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "8090"))

THREAD_URL = f"https://www.messenger.com/t/{THREAD_ID}"
