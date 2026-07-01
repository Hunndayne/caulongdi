"""Client gọi Worker tingting-api: POST /api/bot/message."""

import logging

import httpx

import config

log = logging.getLogger("worker_client")

_HEADERS = {
    "Authorization": f"Bearer {config.BOT_SERVICE_SECRET}",
    "Content-Type": "application/json",
}


async def ask_worker(
    text: str,
    sender_name: str | None = None,
    context: list[dict] | None = None,
    thread_id: str | None = None,
) -> str | None:
    """Forward tin nhắn lên Worker, trả về chuỗi reply (None nếu lỗi/không có).

    context: các tin gần nhất trước tin hiện tại [{role: user|assistant, text}] —
    Worker dùng để hiểu tham chiếu kiểu "buổi đó", "kèo vừa rồi".
    """
    payload: dict = {"threadId": thread_id or config.THREAD_ID, "text": text}
    if sender_name:
        payload["senderName"] = sender_name
    if context:
        payload["context"] = context
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(config.BOT_MESSAGE_ENDPOINT, json=payload, headers=_HEADERS)
    except httpx.HTTPError as exc:
        log.error("Không gọi được Worker: %s", exc)
        return None
    if resp.status_code != 200:
        log.error("Worker trả %s: %s", resp.status_code, resp.text[:300])
        return None
    data = resp.json()
    reply = (data or {}).get("reply")
    return reply.strip() if isinstance(reply, str) and reply.strip() else None


async def fetch_outbox(thread_id: str | None = None) -> list[dict]:
    """Kéo các tin Worker muốn chủ động gửi (nhắc kèo, báo kèo mới...). Lỗi → []."""
    url = f"{config.WORKER_URL}/api/bot/outbox"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params={"threadId": thread_id or config.THREAD_ID}, headers=_HEADERS)
    except httpx.HTTPError as exc:
        log.warning("Không kéo được outbox: %s", exc)
        return []
    if resp.status_code != 200:
        log.warning("Outbox trả %s: %s", resp.status_code, resp.text[:200])
        return []
    messages = (resp.json() or {}).get("messages")
    return [m for m in messages if isinstance(m, dict) and m.get("id") and m.get("text")] if isinstance(messages, list) else []


async def fetch_outbox_all() -> list[dict]:
    """Kéo tin chờ gửi của MỌI thread (chế độ rover). Trả [{id, thread_id, text}], lỗi → []."""
    url = f"{config.WORKER_URL}/api/bot/outbox/all"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=_HEADERS)
    except httpx.HTTPError as exc:
        log.warning("Không kéo được outbox/all: %s", exc)
        return []
    if resp.status_code != 200:
        log.warning("Outbox/all trả %s: %s", resp.status_code, resp.text[:200])
        return []
    messages = (resp.json() or {}).get("messages")
    if not isinstance(messages, list):
        return []
    return [m for m in messages if isinstance(m, dict) and m.get("id") and m.get("text") and m.get("thread_id")]


async def summarize_thread(thread_id: str, messages: list[dict]) -> bool:
    """Gửi messages lên Worker tóm tắt → Worker ghi vào D1 rồi trả True nếu thành công."""
    url = f"{config.WORKER_URL}/api/bot/summarize"
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                url,
                json={"threadId": thread_id, "messages": messages},
                headers=_HEADERS,
            )
    except httpx.HTTPError as exc:
        log.error("Không tóm tắt được thread %s: %s", thread_id, exc)
        return False
    if resp.status_code != 200:
        log.error("Summarize trả %s: %s", resp.status_code, resp.text[:300])
        return False
    data = resp.json()
    return bool((data or {}).get("ok"))


async def ack_outbox(ids: list[str]) -> None:
    """Báo Worker các tin outbox đã gửi xong (best effort)."""
    if not ids:
        return
    url = f"{config.WORKER_URL}/api/bot/outbox/ack"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            await client.post(url, json={"ids": ids}, headers=_HEADERS)
    except httpx.HTTPError as exc:
        log.warning("Không ACK được outbox %s: %s", ids, exc)
