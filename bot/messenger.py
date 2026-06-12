"""Lớp Playwright nói chuyện với messenger.com — phần DỄ VỠ nhất của hệ thống.

Mọi selector phụ thuộc DOM của Facebook gom hết vào file này; khi FB đổi UI
chỉ cần sửa _EXTRACT_JS và các selector bên dưới.
"""

import asyncio
import logging

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

import config

log = logging.getLogger("messenger")

# Tiết kiệm RAM/CPU: chặn ảnh, video/audio, font. KHÔNG chặn CSS/JS (messenger cần để chạy).
_BLOCKED_RESOURCE_TYPES = {"image", "media", "font"}

_BROWSER_ARGS = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-extensions",
]

# Ô soạn tin nhắn của messenger.
_TEXTBOX_SELECTOR = 'div[role="textbox"][contenteditable="true"]'

# Nút đóng các dialog/popup FB hay đè lên trang (chặn click vào ô soạn tin).
_CLOSE_BUTTON_SELECTOR = '[role="dialog"] [aria-label="Đóng"], [role="dialog"] [aria-label="Close"]'

# Trích các message cuối cùng: [{sender, text, label}].
# DOM messenger (kiểm chứng 2026-06): tin nhắn nằm trong [role="log"],
# mỗi tin là div[role="article"]; bên trong có phần tử mang aria-label dạng
# "Tin nhắn do <tên> gửi lúc <giờ>: <nội dung>" (UI tiếng Việt) — parse được
# cả sender + text, và label (có giờ gửi) làm khoá dedupe.
# Fallback khi không match (UI đổi ngôn ngữ/sự kiện hệ thống): lấy innerText
# hiển thị, lọc bỏ dòng boilerplate cho screen-reader.
_EXTRACT_JS = """
() => {
  const root = document.querySelector('[role="log"]') || document;
  const rows = Array.from(root.querySelectorAll('div[role="article"]'));
  return rows.slice(-30).map((row) => {
    const labelEl = row.querySelector('[aria-label*="Tin nhắn do"]');
    const label = labelEl ? (labelEl.getAttribute('aria-label') || '') : '';
    const m = label.match(/Tin nhắn do (.+?) gửi lúc (.+?): ([\\s\\S]*)/);
    if (m) return { sender: m[1].trim(), text: m[3].trim(), label };
    const lines = (row.innerText || '')
      .split('\\n')
      .map((s) => s.trim())
      .filter((s) => s && !/Tin nhắn do|sent a message|message sent/i.test(s));
    const heading = row.querySelector('h4, h5');
    const sender = heading ? (heading.innerText || '').trim() : null;
    return { sender, text: lines.join('\\n'), label: label || lines.join('|').slice(0, 120) };
  }).filter((m) => m.text);
}
"""


class LoginRequired(Exception):
    """Cookie hết hạn — cần chạy lại save_login.py."""


class MessengerClient:
    """Một browser, mỗi thread trong config.THREAD_IDS một tab."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.pages: dict[str, Page] = {}

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=config.HEADLESS, args=_BROWSER_ARGS
        )
        self._context = await self._browser.new_context(storage_state=config.STORAGE_STATE)
        await self._context.route("**/*", self._block_heavy_resources)
        for thread_id in config.THREAD_IDS:
            page = await self._context.new_page()
            await page.goto(config.thread_url(thread_id), wait_until="domcontentloaded", timeout=60_000)
            self._check_logged_in(page)
            await page.wait_for_selector(_TEXTBOX_SELECTOR, timeout=30_000)
            await self._dismiss_overlays(page)
            self.pages[thread_id] = page
            log.info("Đã mở thread %s", thread_id)

    def _page(self, thread_id: str) -> Page:
        page = self.pages.get(thread_id)
        if page is None:
            raise KeyError(f"Thread {thread_id} không nằm trong THREAD_IDS")
        return page

    async def _dismiss_overlays(self, page: Page) -> None:
        """Đóng popup/dialog FB đè lên trang — best effort, không có cũng không sao."""
        for _ in range(3):
            btn = page.locator(_CLOSE_BUTTON_SELECTOR).first
            try:
                if not await btn.is_visible():
                    break
                await btn.click(timeout=2_000)
                log.info("Đã đóng một dialog/popup FB")
                await asyncio.sleep(0.3)
            except Exception:  # noqa: BLE001 — dialog có thể tự biến mất giữa chừng
                break

    async def _block_heavy_resources(self, route, request) -> None:
        if request.resource_type in _BLOCKED_RESOURCE_TYPES:
            await route.abort()
        else:
            await route.continue_()

    def _check_logged_in(self, page: Page) -> None:
        url = page.url if page else ""
        if "login" in url or "checkpoint" in url:
            raise LoginRequired(f"Bị chuyển tới {url} — cookie hết hạn, chạy lại save_login.py")

    async def read_messages(self, thread_id: str) -> list[dict]:
        """Trả về tối đa 30 tin cuối của thread: [{sender, text, label}]."""
        page = self._page(thread_id)
        self._check_logged_in(page)
        return await page.evaluate(_EXTRACT_JS)

    async def send(self, text: str, thread_id: str | None = None) -> None:
        """Gõ reply vào ô soạn tin của thread. Xuống dòng Shift+Enter, gửi Enter."""
        page = self._page(thread_id or config.THREAD_ID)
        await self._dismiss_overlays(page)
        box = page.locator(_TEXTBOX_SELECTOR).last
        try:
            await box.click(timeout=5_000)
        except Exception:  # noqa: BLE001 — overlay chặn click: focus thẳng bằng JS
            log.warning("Click textbox bị chặn, fallback focus bằng JS")
            await box.evaluate("el => el.focus()")
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if i > 0:
                await page.keyboard.press("Shift+Enter")
            if line:
                # insert_text dán nguyên văn, không kích hoạt phím tắt/emoji-autocomplete
                await page.keyboard.insert_text(line)
        await page.keyboard.press("Enter")
        # Cho messenger kịp đẩy tin lên trước lần đọc kế tiếp
        await asyncio.sleep(0.5)

    async def close(self) -> None:
        for closer in (self._context, self._browser):
            try:
                if closer:
                    await closer.close()
            except Exception:  # noqa: BLE001 — đóng best-effort khi restart
                pass
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception:  # noqa: BLE001
                pass
        self._playwright = self._browser = self._context = None
        self.pages = {}
