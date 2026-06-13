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
# Reload nhẹ định kỳ (phút): reload các tab cố định + reset rover để gỡ kẹt khi
# trang Messenger treo/đứng ở 1 chat. 0 = tắt. Nhẹ hơn nhiều so với RESTART_HOURS.
REFRESH_MINUTES = float(os.getenv("REFRESH_MINUTES", "15"))
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "8090"))

# Rover: tab tuần tra tự phát hiện group chat ngoài THREAD_IDS qua sidebar.
# Mỗi ROVER_INTERVAL_SECONDS ghé một thread (round-robin) — RAM cố định 1 tab phụ.
ROVER_ENABLED = os.getenv("ROVER_ENABLED", "true").strip().lower() != "false"
ROVER_INTERVAL_SECONDS = float(os.getenv("ROVER_INTERVAL_SECONDS", "15"))
ROVER_MAX_THREADS = int(os.getenv("ROVER_MAX_THREADS", "10"))
# Khi rover ghé 1 thread bị lỗi (trang không tải được, không có khung tin), tạm
# bỏ qua thread đó trong bao nhiêu phút để khỏi đập vào nó mỗi vòng (chặn loop).
ROVER_SKIP_MINUTES = float(os.getenv("ROVER_SKIP_MINUTES", "30"))

# Múi giờ bot dùng để tính QUIET_HOURS — tường minh để KHÔNG phụ thuộc múi giờ
# ambient của host. Tiến trình khởi động trước khi đổi tz hệ thống vẫn cache UTC
# (glibc), khiến bot ngủ nhầm khung 09:00-11:00 thay vì 02:00-04:00 giờ VN.
BOT_TZ = os.getenv("BOT_TZ", "Asia/Ho_Chi_Minh").strip()

# Giờ ngủ hằng ngày (theo BOT_TZ, dạng "HH:MM-HH:MM") — bot tắt browser hẳn để
# hành vi giống người thật, giảm nghi ngờ từ Facebook. Để rỗng nếu muốn chạy 24/7.
QUIET_HOURS = os.getenv("QUIET_HOURS", "02:00-04:00").strip()

# Nhịp kéo outbox từ Worker (giây) — tách khỏi POLL_SECONDS để tiết kiệm quota
# Workers free (100k req/ngày): 60s ≈ 1.440 req/ngày thay vì 21.600 nếu theo nhịp 4s.
OUTBOX_POLL_SECONDS = float(os.getenv("OUTBOX_POLL_SECONDS", "60"))

def thread_url(thread_id: str) -> str:
    return f"https://www.messenger.com/t/{thread_id}"


THREAD_URL = thread_url(THREAD_ID)  # tương thích cũ
