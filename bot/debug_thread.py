"""Chẩn đoán 1 thread bị lỗi _wait_ready (không có [role=log] lẫn textbox).

Chạy:
  python debug_thread.py <thread_id>                  # chỉ dump hiện trạng
  python debug_thread.py <thread_id> "tin nhắn test"  # dump xong thử GỬI tin

- KHÔNG chờ textbox (đó chính là thứ đang fail) — chỉ goto rồi dump hiện trạng.
- In URL sau goto (bắt redirect sang trang "không khả dụng"), đếm role, in
  ~2000 ký tự innerText, lưu ảnh thread-<id>.png và ghi diag ra thread-<id>.json.
- Nếu có tham số tin nhắn: tìm ô soạn, gõ và Enter — báo gửi được hay không.
"""

import asyncio
import json
import sys

from playwright.async_api import async_playwright

# Console Windows hay là cp1252 → ép UTF-8 để khỏi UnicodeEncodeError khi in tiếng Việt.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 — môi trường cũ không có reconfigure thì kệ
    pass

STORAGE = "storage_state.json"
THREAD_ID = sys.argv[1] if len(sys.argv) > 1 else "1931449847753723"
SEND_TEXT = sys.argv[2] if len(sys.argv) > 2 else None
URL = f"https://www.messenger.com/t/{THREAD_ID}"
TEXTBOX = 'div[role="textbox"][contenteditable="true"]'

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
        await asyncio.sleep(8)  # cho FB kịp render SPA (không chờ selector cụ thể)
        print("URL sau goto:", page.url)

        diag = await page.evaluate(DIAG_JS)
        out_json = f"thread-{THREAD_ID}.json"
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(diag, f, ensure_ascii=False, indent=2)
        print(f"\n=== DIAG (đã ghi {out_json}) ===")
        print(json.dumps(diag, ensure_ascii=False, indent=2))

        shot = f"thread-{THREAD_ID}.png"
        await page.screenshot(path=shot, full_page=False)
        print(f"\nĐã lưu ảnh: {shot}")

        if SEND_TEXT:
            print(f"\n=== THỬ GỬI: {SEND_TEXT!r} ===")
            try:
                box = page.locator(TEXTBOX).last
                await box.click(timeout=5_000)
                await page.keyboard.insert_text(SEND_TEXT)
                await page.keyboard.press("Enter")
                await asyncio.sleep(1.5)
                print("Gửi: OK (đã nhấn Enter, kiểm tra lại trong chat)")
            except Exception as exc:  # noqa: BLE001
                print(f"Gửi: THẤT BẠI — {type(exc).__name__}: {exc}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
