"""Chẩn đoán DOM messenger.com — chạy local để tìm selector mới khi _EXTRACT_JS chết.

Chạy: python debug_dom.py [needle]
- Chờ tin nhắn render thật (needle xuất hiện trong innerText, bỏ qua <script>).
- Đếm selector ứng viên, in ancestors của needle, dump cấu trúc [role="log"].
"""

import asyncio
import json
import sys

from playwright.async_api import async_playwright

THREAD_URL = "https://www.messenger.com/t/1724309058727425"
STORAGE = "storage_state.json"
NEEDLE = sys.argv[1] if len(sys.argv) > 1 else "/help"

DIAG_JS = """
() => {
  const count = (sel) => document.querySelectorAll(sel).length;
  const sels = [
    'div[role="row"]', '[role="grid"]', '[role="gridcell"]',
    '[role="list"]', '[role="listitem"]', '[role="article"]', '[role="log"]',
    'div[dir="auto"]', '[role="textbox"]',
  ];
  const counts = {};
  for (const s of sels) counts[s] = count(s);
  const roles = {};
  for (const el of document.querySelectorAll('[role]')) {
    const r = el.getAttribute('role');
    roles[r] = (roles[r] || 0) + 1;
  }
  return { counts, roles };
}
"""

# innerText bỏ qua script/style và phần tử ẩn — đúng "những gì user nhìn thấy"
WAIT_JS = "(needle) => document.body.innerText.includes(needle)"

ANCESTORS_JS = """
(needle) => {
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    if (el.innerText && el.innerText.includes(needle)) best = el; // sâu nhất = lần gán cuối
  }
  if (!best) return null;
  const chain = [];
  let cur = best;
  for (let i = 0; cur && cur.tagName !== 'BODY' && i < 15; i++, cur = cur.parentElement) {
    chain.push({
      tag: cur.tagName.toLowerCase(),
      role: cur.getAttribute('role'),
      dir: cur.getAttribute('dir'),
      ariaLabel: (cur.getAttribute('aria-label') || '').slice(0, 80) || null,
      text: (cur.innerText || '').trim().slice(0, 60),
    });
  }
  return chain;
}
"""

LOG_STRUCTURE_JS = """
() => {
  const logEl = document.querySelector('[role="log"]');
  if (!logEl) return null;
  // Mỗi con trực tiếp (vài tầng) của log: tag/role + text ngắn — để thấy 1 tin = 1 node nào
  const describe = (el, depth) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    dir: el.getAttribute('dir'),
    text: (el.innerText || '').trim().slice(0, 50),
    kids: depth > 0
      ? Array.from(el.children).slice(0, 12).map((c) => describe(c, depth - 1))
      : el.children.length,
  });
  return describe(logEl, 3);
}
"""


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(storage_state=STORAGE)
        page = await context.new_page()
        await page.goto(THREAD_URL, wait_until="domcontentloaded", timeout=60_000)
        print("URL sau goto:", page.url)
        await page.wait_for_selector('div[role="textbox"][contenteditable="true"]', timeout=30_000)
        print("Textbox: OK")

        try:
            await page.wait_for_function(WAIT_JS, arg=NEEDLE, timeout=30_000)
            print(f"Needle {NEEDLE!r}: đã render trong innerText")
        except Exception:  # noqa: BLE001
            print(f"Needle {NEEDLE!r}: KHÔNG xuất hiện sau 30s — dump hiện trạng")

        diag = await page.evaluate(DIAG_JS)
        print("\n=== DIAG ===")
        print(json.dumps(diag, ensure_ascii=False, indent=2))

        chain = await page.evaluate(ANCESTORS_JS, NEEDLE)
        print(f"\n=== ANCESTORS của {NEEDLE!r} ===")
        print(json.dumps(chain, ensure_ascii=False, indent=2))

        structure = await page.evaluate(LOG_STRUCTURE_JS)
        print('\n=== CẤU TRÚC [role="log"] ===')
        print(json.dumps(structure, ensure_ascii=False, indent=2))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
