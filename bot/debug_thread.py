"""Chẩn đoán 1 thread bị lỗi _wait_ready (không có [role=log] lẫn textbox).

Chạy trên server: python debug_thread.py <thread_id>
- KHÔNG chờ textbox (đó chính là thứ đang fail) — chỉ goto rồi dump hiện trạng.
- In URL sau goto (bắt redirect sang trang "không khả dụng"), đếm các role,
  in ~2000 ký tự innerText (thường lộ thẳng "Bạn không thể trả lời..." v.v.),
  và lưu ảnh chụp thread-<id>.png để nhìn tận mắt.
"""

import asyncio
import json
import sys

from playwright.async_api import async_playwright

STORAGE = "storage_state.json"
THREAD_ID = sys.argv[1] if len(sys.argv) > 1 else "1931449847753723"
URL = f"https://www.messenger.com/t/{THREAD_ID}"

DIAG_JS = """
() => {
  const roles = {};
  for (const el of document.querySelectorAll('[role]')) {
    const r = el.getAttribute('role');
    roles[r] = (roles[r] || 0) + 1;
  }
  const has = (sel) => document.querySelectorAll(sel).length;
  return {
    title: document.title,
    log: has('[role="log"]'),
    textbox: has('div[role="textbox"][contenteditable="true"]'),
    main: has('[role="main"]'),
    article: has('[role="article"]'),
    roles,
    bodyText: (document.body.innerText || '').slice(0, 2000),
  };
}
"""


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(storage_state=STORAGE)
        page = await context.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
        # Cho FB kịp render SPA (không chờ selector cụ thể).
        await asyncio.sleep(8)
        print("URL sau goto:", page.url)

        diag = await page.evaluate(DIAG_JS)
        print("\n=== DIAG ===")
        print(json.dumps(diag, ensure_ascii=False, indent=2))

        shot = f"thread-{THREAD_ID}.png"
        await page.screenshot(path=shot, full_page=False)
        print(f"\nĐã lưu ảnh: {shot}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
