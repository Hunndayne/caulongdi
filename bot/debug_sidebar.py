"""Soi sidebar messenger: danh sách thread + dấu hiệu chưa đọc — chạy local."""

import asyncio
import json

from playwright.async_api import async_playwright

THREAD_URL = "https://www.messenger.com/t/1724309058727425"

SIDEBAR_JS = """
() => {
  // Các link hội thoại trong sidebar: a[href^="/t/"]
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/t/"]')) {
    const href = a.getAttribute('href') || '';
    const threadId = (href.match(/\\/t\\/(\\d+)/) || [])[1];
    if (!threadId) continue;
    // dấu hiệu chưa đọc: messenger thường bold tên/tin nhắn hoặc có aria-label/unread dot
    const label = (a.getAttribute('aria-label') || '').slice(0, 100);
    const text = (a.innerText || '').replace(/\\n/g, ' | ').slice(0, 90);
    const hasUnreadDot = Boolean(a.querySelector('[aria-label*="chưa đọc"], [aria-label*="unread"], [data-visualcompletion="ignore"]'));
    const fontWeights = [...new Set(Array.from(a.querySelectorAll('span'))
      .map((s) => getComputedStyle(s).fontWeight)
      .filter((w) => Number(w) >= 600))];
    out.push({ threadId, label: label || null, text, hasUnreadDot, boldWeights: fontWeights });
  }
  return out;
}
"""


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(storage_state="storage_state.json")
        page = await context.new_page()
        await page.goto(THREAD_URL, wait_until="domcontentloaded", timeout=60_000)
        print("URL:", page.url)
        try:
            await page.wait_for_selector('a[href^="/t/"]', timeout=30_000)
        except Exception as exc:  # noqa: BLE001
            print("Không thấy sidebar:", exc)
        await asyncio.sleep(3)
        print(json.dumps(await page.evaluate(SIDEBAR_JS), ensure_ascii=False, indent=2))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
