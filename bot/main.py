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
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import config
from messenger import LoginRequired, MessengerClient
from worker_client import ack_outbox, ask_worker, fetch_outbox_all

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


def _is_own_message(m: dict) -> bool:
    return (m.get("sender") or "").strip().lower() in ("bạn", "you")


async def _forward_and_reply(client: MessengerClient, thread_id: str, messages: list[dict], m: dict) -> bool:
    """Forward một tin lên Worker và gửi reply (nếu có). Trả về True nếu đã reply."""
    sender = m.get("sender")
    log.info("[%s] Forward từ %s: %r", thread_id, sender or "?", m["text"][:120])
    state["messages_forwarded"] += 1
    context = _build_context(messages, m)
    reply = await ask_worker(_clean_mention(m["text"]), sender, context, thread_id)
    if reply:
        async with _send_lock:
            await client.send(reply, thread_id)
        state["replies_sent"] += 1
        return True
    return False


async def _process_new_messages(
    client: MessengerClient,
    thread_id: str,
    prev_keys: list[str],
    process_baseline_command: bool = False,
) -> list[str]:
    """So sánh đuôi danh sách tin với lần đọc trước, xử lý phần mới, trả về keys hiện tại."""
    messages = await client.read_messages(thread_id)
    keys = [_msg_key(m) for m in messages]

    # MỎ NEO AN TOÀN: tin gần nhất của chính bot là ranh giới "đã xử lý" —
    # không bao giờ đọc/trả lời lệnh nằm trước nó, kể cả khi mất mốc prev_keys
    # (restart, DOM vẽ lại). Chống trả lời lại hàng loạt lệnh cũ.
    last_own_idx = max((i for i, m in enumerate(messages) if _is_own_message(m)), default=-1)

    if not prev_keys:
        # Baseline — không reply lịch sử. Riêng thread rover mới phát hiện: xử lý
        # lệnh "/" cuối cùng SAU tin cuối của bot (để "/connect" gõ trước khi rover
        # kịp ghé vẫn được trả lời, nhưng lệnh đã trả lời rồi thì không lặp lại).
        if process_baseline_command:
            unanswered = messages[last_own_idx + 1 :]
            if unanswered:
                last = unanswered[-1]
                if not _is_own_message(last) and last["text"].strip().startswith("/"):
                    await _forward_and_reply(client, thread_id, messages, last)
                    keys = [_msg_key(x) for x in await client.read_messages(thread_id)]
        return keys

    # Tìm tin cuối của lần trước trong danh sách hiện tại; phần sau nó là tin mới.
    last_prev = prev_keys[-1]
    try:
        idx = len(keys) - 1 - keys[::-1].index(last_prev)
        new_messages = messages[max(idx, last_own_idx) + 1 :]
    except ValueError:
        # Không thấy mốc cũ (DOM bị cuộn/vẽ lại) — fallback: tin chưa từng thấy,
        # nhưng CHỈ tính từ sau tin cuối của bot trở đi.
        prev_set = set(prev_keys)
        new_messages = [m for m in messages[last_own_idx + 1 :] if _msg_key(m) not in prev_set]

    for m in new_messages:
        text = m["text"]
        # Tin của chính bot (UI tiếng Việt hiện "Bạn") — bỏ qua để không tự reply vòng lặp
        if _is_own_message(m):
            continue
        if not _should_forward(text):
            log.info("Bỏ qua (không phải lệnh/@bot) từ %s: %r", m.get("sender") or "?", text[:80])
            continue
        if await _forward_and_reply(client, thread_id, messages, m):
            # Reply của chính mình sẽ xuất hiện ở lần đọc sau — không lọt filter
            # vì không bắt đầu bằng "/" và không @nhắc bot.
            keys = [_msg_key(x) for x in await client.read_messages(thread_id)]
    return keys


async def _drain_outbox(client: MessengerClient) -> None:
    """Gửi các tin Worker chủ động xếp hàng (mọi thread đã liên kết, kể cả thread rover)."""
    sent_ids: list[str] = []
    for item in await fetch_outbox_all():
        thread_id = item.get("thread_id") or ""
        if not thread_id or (not client.has_dedicated(thread_id) and not config.ROVER_ENABLED):
            continue  # không có đường gửi — giữ lại trong outbox
        try:
            async with _send_lock:
                await client.send(item["text"], thread_id)
        except Exception:  # noqa: BLE001 — gửi hỏng thì giữ lại tin trong outbox, thử vòng sau
            log.exception("[%s] Gửi tin outbox %s thất bại, sẽ thử lại", thread_id, item["id"])
            continue
        sent_ids.append(item["id"])
        state["replies_sent"] += 1
        log.info("[%s] Đã gửi tin outbox %s", thread_id, item["id"])
    # ACK gộp một lần — tiết kiệm request Worker
    await ack_outbox(sent_ids)


async def _rover_tick(client: MessengerClient, rover_keys: dict[str, list[str]], rover_queue: list[str]) -> None:
    """Ghé một group chat ngoài THREAD_IDS (round-robin theo sidebar) bằng tab rover."""
    if not rover_queue:
        sidebar = await client.list_sidebar_threads()
        others = [t for t in sidebar if not client.has_dedicated(t)][: config.ROVER_MAX_THREADS]
        # Quên các thread đã rời sidebar (bị kick/ẩn) để khỏi giữ keys vô hạn.
        for stale in [t for t in rover_keys if t not in others]:
            rover_keys.pop(stale, None)
        rover_queue.extend(others)
        if not rover_queue:
            return
    thread_id = rover_queue.pop(0)
    first_visit = thread_id not in rover_keys
    if first_visit:
        log.info("[rover] Phát hiện thread mới trong sidebar: %s", thread_id)
    try:
        rover_keys[thread_id] = await _process_new_messages(
            client, thread_id, rover_keys.get(thread_id, []), process_baseline_command=first_visit
        )
    except LoginRequired:
        raise
    except Exception:  # noqa: BLE001 — bị kick/lỗi điều hướng: bỏ vòng này, lần sau sidebar quyết định lại
        log.exception("[rover] Lỗi khi ghé thread %s", thread_id)


def _quiet_until() -> float | None:
    """Nếu đang trong giờ ngủ (QUIET_HOURS, giờ máy chủ) → timestamp lúc thức dậy; ngược lại None."""
    if not config.QUIET_HOURS:
        return None
    try:
        start_raw, end_raw = config.QUIET_HOURS.split("-")
        sh, sm = int(start_raw[:2]), int(start_raw[3:5])
        eh, em = int(end_raw[:2]), int(end_raw[3:5])
    except (ValueError, IndexError):
        log.warning("QUIET_HOURS không hợp lệ: %r — bỏ qua", config.QUIET_HOURS)
        return None

    now = datetime.now(ZoneInfo(config.BOT_TZ))
    start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if start <= end:  # cửa sổ trong cùng một ngày (vd 02:00-04:00)
        if start <= now < end:
            return end.timestamp()
        return None
    # cửa sổ vắt qua nửa đêm (vd 23:00-04:00)
    if now >= start:
        return (end + timedelta(days=1)).timestamp()
    if now < end:
        return end.timestamp()
    return None


async def watcher() -> None:
    global _client
    while True:
        # Giờ ngủ hằng ngày: browser tắt hẳn, hành vi giống người thật.
        wake_at = _quiet_until()
        if wake_at:
            if state["status"] != "sleeping":
                log.info("Giờ ngủ (%s) — bot offline đến %s", config.QUIET_HOURS,
                         datetime.fromtimestamp(wake_at, ZoneInfo(config.BOT_TZ)).strftime("%H:%M"))
            state["status"] = "sleeping"
            await asyncio.sleep(min(max(wake_at - time.time(), 5), 300))
            continue

        client = MessengerClient()
        try:
            await client.start()
            _client = client
            state["status"] = "running"
            state["browser_started_at"] = time.time()
            state["last_error"] = None
            restart_at = time.time() + config.RESTART_HOURS * 3600
            prev_keys_by_thread: dict[str, list[str]] = {tid: [] for tid in config.THREAD_IDS}
            rover_keys: dict[str, list[str]] = {}
            rover_queue: list[str] = []
            next_rover_at = time.time() + config.ROVER_INTERVAL_SECONDS
            next_outbox_at = time.time() + config.OUTBOX_POLL_SECONDS
            while time.time() < restart_at:
                if _quiet_until():
                    log.info("Đến giờ ngủ (%s) — đóng browser", config.QUIET_HOURS)
                    break
                for thread_id in config.THREAD_IDS:
                    prev_keys_by_thread[thread_id] = await _process_new_messages(
                        client, thread_id, prev_keys_by_thread[thread_id]
                    )
                if config.ROVER_ENABLED and time.time() >= next_rover_at:
                    await _rover_tick(client, rover_keys, rover_queue)
                    next_rover_at = time.time() + config.ROVER_INTERVAL_SECONDS
                # Outbox nhịp riêng (mặc định 60s) — tiết kiệm quota Worker free
                if time.time() >= next_outbox_at:
                    await _drain_outbox(client)
                    next_outbox_at = time.time() + config.OUTBOX_POLL_SECONDS
                state["last_poll_at"] = time.time()
                await asyncio.sleep(config.POLL_SECONDS)
            else:
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
    threadId: str | None = None  # mặc định: thread đầu tiên trong THREAD_IDS


@app.post("/send")
async def send_manual(body: SendBody):
    """Gửi tin thủ công vào thread (test). Chỉ bind localhost."""
    if _client is None or state["status"] != "running":
        raise HTTPException(503, f"Bot chưa sẵn sàng (status={state['status']})")
    thread_id = body.threadId or config.THREAD_ID
    if not _client.has_dedicated(thread_id) and not config.ROVER_ENABLED:
        raise HTTPException(400, f"threadId {thread_id} không có tab cố định và rover đang tắt")
    async with _send_lock:
        await _client.send(body.text, thread_id)
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT)
