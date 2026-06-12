"""Client gọi Worker tingting-api: POST /api/bot/message."""

import logging

import httpx

import config

log = logging.getLogger("worker_client")

_HEADERS = {
    "Authorization": f"Bearer {config.BOT_SERVICE_SECRET}",
    "Content-Type": "application/json",
}


async def ask_worker(text: str, sender_name: str | None = None) -> str | None:
    """Forward tin nhắn lên Worker, trả về chuỗi reply (None nếu lỗi/không có)."""
    payload: dict = {"threadId": config.THREAD_ID, "text": text}
    if sender_name:
        payload["senderName"] = sender_name
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
