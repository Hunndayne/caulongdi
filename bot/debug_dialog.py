"""Soi dialog/overlay đang đè lên messenger — chạy local."""

import asyncio
import json

from playwright.async_api import async_playwright

THREAD_URL = "https://www.messenger.com/t/1724309058727425"

DIALOG_JS = """
() => {
  const out = [];
  for (const d of document.querySelectorAll('[role="dialog"], .__fb-light-mode')) {
    const buttons = Array.from(d.querySelectorAll('[role="button"], button')).map(
      (b) => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 50)
    );
    out.push({
      tag: d.tagName.toLowerCase(),
      role: d.getAttribute('role'),
      cls: (d.className || '').toString().slice(0, 80),
      ariaLabel: d.getAttribute('aria-label'),
      text: (d.innerText || '').trim().slice(0, 300),
      buttons: buttons.slice(0, 10),
    });
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
        await page.wait_for_selector('div[role="textbox"][contenteditable="true"]', timeout=30_000)
        await asyncio.sleep(3)
        print(json.dumps(await page.evaluate(DIALOG_JS), ensure_ascii=False, indent=2))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
