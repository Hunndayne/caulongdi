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

# Trích các message row cuối cùng: [{sender, text, label}].
# - row: div[role="row"] trong khung chat.
# - text: ghép các div[dir="auto"] (bong bóng tin nhắn).
# - sender: heading h4/h5 (messenger hiện tên ở tin đầu của một cụm) — best effort,
#   có thể null với các tin liền cụm.
# - label: aria-label của row (thường chứa tên người gửi + giờ gửi) — dùng làm
#   thành phần khoá dedupe để hai tin trùng nội dung không bị coi là một.
_EXTRACT_JS = """
() => {
  const rows = Array.from(document.querySelectorAll('div[role="row"]'));
  return rows.slice(-30).map((row) => {
    const texts = Array.from(row.querySelectorAll('div[dir="auto"]'))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean);
    const heading = row.querySelector('h4, h5');
    const sender = heading ? (heading.innerText || '').trim() : null;
    const label = row.getAttribute('aria-label') || '';
    return { sender, text: texts.join('\\n'), label };
  }).filter((m) => m.text);
}
"""


class LoginRequired(Exception):
    """Cookie hết hạn — cần chạy lại save_login.py."""


class MessengerClient:
    def __init__(self) -> None:
        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.page: Page | None = None

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=config.HEADLESS, args=_BROWSER_ARGS
        )
        self._context = await self._browser.new_context(storage_state=config.STORAGE_STATE)
        await self._context.route("**/*", self._block_heavy_resources)
        self.page = await self._context.new_page()
        await self.page.goto(config.THREAD_URL, wait_until="domcontentloaded", timeout=60_000)
        self._check_logged_in()
        await self.page.wait_for_selector(_TEXTBOX_SELECTOR, timeout=30_000)
        log.info("Đã mở thread %s", config.THREAD_ID)

    async def _block_heavy_resources(self, route, request) -> None:
        if request.resource_type in _BLOCKED_RESOURCE_TYPES:
            await route.abort()
        else:
            await route.continue_()

    def _check_logged_in(self) -> None:
        url = self.page.url if self.page else ""
        if "login" in url or "checkpoint" in url:
            raise LoginRequired(f"Bị chuyển tới {url} — cookie hết hạn, chạy lại save_login.py")

    async def read_messages(self) -> list[dict]:
        """Trả về tối đa 30 tin cuối: [{sender, text, label}]."""
        self._check_logged_in()
        return await self.page.evaluate(_EXTRACT_JS)

    async def send(self, text: str) -> None:
        """Gõ reply vào ô soạn tin. Xuống dòng bằng Shift+Enter, gửi bằng Enter."""
        box = self.page.locator(_TEXTBOX_SELECTOR).last
        await box.click()
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if i > 0:
                await self.page.keyboard.press("Shift+Enter")
            if line:
                # insert_text dán nguyên văn, không kích hoạt phím tắt/emoji-autocomplete
                await self.page.keyboard.insert_text(line)
        await self.page.keyboard.press("Enter")
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
        self._playwright = self._browser = self._context = self.page = None
