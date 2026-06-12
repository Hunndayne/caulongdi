"""Bot Messenger cho TingTing — Phase 2.

Vòng đời:
  FastAPI lifespan ──▶ watcher() chạy nền
    └─ launch Playwright ─▶ baseline tin cũ (không reply lịch sử)
       └─ poll mỗi POLL_SECONDS: tin mới + (bắt đầu "/" hoặc @BOT_NAME)
          ─▶ POST Worker ─▶ gửi reply vào chat
    └─ restart browser mỗi RESTART_HOURS (chống memory creep)

Python chỉ làm I/O Facebook — mọi logic NLU/D1/format nằm ở Worker.
"""

import asyncio
import logging
import time
import unicodedata
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import config
from messenger import LoginRequired, MessengerClient
from worker_client import ask_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

# Trạng thái cho /healthz
state = {
    "status": "starting",  # starting | running | login_required | error
    "last_poll_at": None,
    "messages_forwarded": 0,
    "replies_sent": 0,
    "browser_started_at": None,
    "last_error": None,
}

_client: MessengerClient | None = None
_send_lock = asyncio.Lock()


def _strip_diacritics(s: str) -> str:
    # NFD không tách "đ" (U+0111) — xử lý thủ công, giống Worker.
    s = s.replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


_BOT_NAME_NORM = _strip_diacritics(config.BOT_NAME).lower()


def _should_forward(text: str) -> bool:
    """Chỉ forward lệnh ("/...") hoặc tin @nhắc bot — tránh spam Worker/DeepSeek."""
    stripped = text.strip()
    if stripped.startswith("/"):
        return True
    return _BOT_NAME_NORM in _strip_diacritics(stripped).lower()


def _clean_mention(text: str) -> str:
    """Bỏ '@TenBot'/'TenBot' đầu câu để Worker nhận câu hỏi sạch."""
    stripped = text.strip()
    norm = _strip_diacritics(stripped).lower()
    for prefix in (f"@{_BOT_NAME_NORM}", _BOT_NAME_NORM):
        if norm.startswith(prefix):
            cleaned = stripped[len(prefix):].lstrip(" ,:")
            return cleaned if cleaned else stripped
    return stripped


_CONTEXT_MESSAGES = 8


def _build_context(messages: list[dict], current: dict) -> list[dict]:
    """Các tin liền trước tin hiện tại, làm ngữ cảnh cho Worker ("buổi đó", "kèo vừa rồi"...)."""
    try:
        idx = messages.index(current)
    except ValueError:
        idx = len(messages)
    return [
        {
            "role": "assistant" if (x.get("sender") or "").strip().lower() in ("bạn", "you") else "user",
            "text": x["text"],
        }
        for x in messages[max(0, idx - _CONTEXT_MESSAGES) : idx]
    ]


def _msg_key(m: dict) -> str:
    # label thường chứa tên + giờ gửi → hai tin trùng nội dung vẫn khác khoá.
    return f"{m.get('sender') or ''}|{m.get('text') or ''}|{m.get('label') or ''}"


async def _process_new_messages(client: MessengerClient, prev_keys: list[str]) -> list[str]:
    """So sánh đuôi danh sách tin với lần đọc trước, xử lý phần mới, trả về keys hiện tại."""
    messages = await client.read_messages()
    keys = [_msg_key(m) for m in messages]
    if not prev_keys:
        return keys  # baseline — không reply lịch sử

    # Tìm tin cuối của lần trước trong danh sách hiện tại; phần sau nó là tin mới.
    last_prev = prev_keys[-1]
    try:
        idx = len(keys) - 1 - keys[::-1].index(last_prev)
        new_messages = messages[idx + 1 :]
    except ValueError:
        # Không thấy mốc cũ (DOM bị cuộn/vẽ lại) — fallback: tin chưa từng thấy gần đây.
        prev_set = set(prev_keys)
        new_messages = [m for m in messages if _msg_key(m) not in prev_set]

    for m in new_messages:
        text = m["text"]
        # Tin của chính bot (UI tiếng Việt hiện "Bạn") — bỏ qua để không tự reply vòng lặp
        if (m.get("sender") or "").strip().lower() in ("bạn", "you"):
            continue
        if not _should_forward(text):
            log.info("Bỏ qua (không phải lệnh/@bot) từ %s: %r", m.get("sender") or "?", text[:80])
            continue
        sender = m.get("sender")
        log.info("Forward từ %s: %r", sender or "?", text[:120])
        state["messages_forwarded"] += 1
        context = _build_context(messages, m)
        reply = await ask_worker(_clean_mention(text), sender, context)
        if reply:
            async with _send_lock:
                await client.send(reply)
            state["replies_sent"] += 1
            # Reply của chính mình sẽ xuất hiện ở lần đọc sau — không lọt filter
            # vì không bắt đầu bằng "/" và không @nhắc bot.
            keys = [_msg_key(x) for x in await client.read_messages()]
    return keys


async def watcher() -> None:
    global _client
    while True:
        client = MessengerClient()
        try:
            await client.start()
            _client = client
            state["status"] = "running"
            state["browser_started_at"] = time.time()
            state["last_error"] = None
            restart_at = time.time() + config.RESTART_HOURS * 3600
            prev_keys: list[str] = []
            while time.time() < restart_at:
                prev_keys = await _process_new_messages(client, prev_keys)
                state["last_poll_at"] = time.time()
                await asyncio.sleep(config.POLL_SECONDS)
            log.info("Restart browser định kỳ (%.0f giờ)", config.RESTART_HOURS)
        except LoginRequired as exc:
            # Không tự thoát: giữ process sống để /healthz báo trạng thái.
            state["status"] = "login_required"
            state["last_error"] = str(exc)
            log.error("%s", exc)
            await client.close()
            _client = None
            await asyncio.sleep(300)
            continue
        except asyncio.CancelledError:
            await client.close()
            raise
        except Exception as exc:  # noqa: BLE001 — lớp FB dễ vỡ, log rồi relaunch
            state["status"] = "error"
            state["last_error"] = repr(exc)
            log.exception("Watcher lỗi, relaunch sau 30s")
            await client.close()
            _client = None
            await asyncio.sleep(30)
            continue
        await client.close()
        _client = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(watcher())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return state


@app.get("/debug/messages")
async def debug_messages():
    """Trả về raw output của _EXTRACT_JS — xem bot 'nhìn thấy' gì trong DOM (chỉ để debug)."""
    if _client is None or state["status"] != "running":
        raise HTTPException(503, f"Bot chưa sẵn sàng (status={state['status']})")
    return await _client.read_messages()


class SendBody(BaseModel):
    text: str


@app.post("/send")
async def send_manual(body: SendBody):
    """Gửi tin thủ công vào thread (test). Chỉ bind localhost."""
    if _client is None or state["status"] != "running":
        raise HTTPException(503, f"Bot chưa sẵn sàng (status={state['status']})")
    async with _send_lock:
        await _client.send(body.text)
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT)
