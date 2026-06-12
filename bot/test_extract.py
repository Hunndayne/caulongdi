"""Test _EXTRACT_JS thật từ messenger.py với DOM messenger live — chạy local.

Chạy: python test_extract.py
"""

import asyncio
import json
import os

# config._require chỉ cần các env này tồn tại — giá trị giả đủ để test extraction
os.environ.setdefault("WORKER_URL", "http://placeholder")
os.environ.setdefault("BOT_SERVICE_SECRET", "placeholder")
os.environ.setdefault("THREAD_ID", "1724309058727425")

from playwright.async_api import async_playwright  # noqa: E402

from messenger import _EXTRACT_JS, _TEXTBOX_SELECTOR  # noqa: E402

THREAD_URL = "https://www.messenger.com/t/1724309058727425"


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(storage_state="storage_state.json")
        page = await context.new_page()
        await page.goto(THREAD_URL, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_selector(_TEXTBOX_SELECTOR, timeout=30_000)
        # chờ tin render (article xuất hiện trong log)
        await page.wait_for_selector('[role="log"] div[role="article"]', timeout=30_000)
        await asyncio.sleep(2)
        messages = await page.evaluate(_EXTRACT_JS)
        print(json.dumps(messages, ensure_ascii=False, indent=2))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
