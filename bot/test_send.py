"""Test MessengerClient.send() thật (kèm dismiss overlay) — chạy local.

Chạy: python test_send.py "nội dung tin"
"""

import asyncio
import os
import sys

os.environ.setdefault("WORKER_URL", "http://placeholder")
os.environ.setdefault("BOT_SERVICE_SECRET", "placeholder")
os.environ.setdefault("THREAD_ID", "1724309058727425")

from messenger import MessengerClient  # noqa: E402

TEXT = sys.argv[1] if len(sys.argv) > 1 else "test gửi từ local — bỏ qua tin này"


async def main() -> None:
    client = MessengerClient()
    await client.start()
    await client.send(TEXT)
    print("Đã gửi:", TEXT)
    await asyncio.sleep(2)
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
