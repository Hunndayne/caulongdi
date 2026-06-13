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

# Trang đã sẵn sàng để ĐỌC: có khung danh sách tin HOẶC ô soạn tin. Dùng cái này
# thay cho _TEXTBOX_SELECTOR khi điều hướng — nhiều thread (community, message
# request, chat không reply được) KHÔNG có ô soạn tin nhưng vẫn đọc được tin.
_READY_SELECTOR = f'[role="log"], {_TEXTBOX_SELECTOR}'

# Nút đóng các dialog/popup FB hay đè lên trang (chặn click vào ô soạn tin).
_CLOSE_BUTTON_SELECTOR = '[role="dialog"] [aria-label="Đóng"], [role="dialog"] [aria-label="Close"]'

# Danh sách thread trong sidebar (mọi trang messenger đều có) — theo thứ tự hiển thị.
_SIDEBAR_JS = """
() => {
  const ids = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href^="/t/"]')) {
    const m = (a.getAttribute('href') || '').match(/\\/t\\/(\\d+)/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids;
}
"""

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
    """Một browser: mỗi thread trong config.THREAD_IDS một tab cố định,
    cộng một tab "rover" tuần tra các group chat khác phát hiện qua sidebar."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.pages: dict[str, Page] = {}
        self._rover: Page | None = None
        self._rover_at: str | None = None

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=config.HEADLESS, args=_BROWSER_ARGS
        )
        self._context = await self._browser.new_context(storage_state=config.STORAGE_STATE)
        await self._context.route("**/*", self._block_heavy_resources)
        for thread_id in config.THREAD_IDS:
            page = await self._context.new_page()
            try:
                await page.goto(config.thread_url(thread_id), wait_until="domcontentloaded", timeout=60_000)
                self._check_logged_in(page)
                await self._wait_ready(page, timeout=30_000)
                await self._dismiss_overlays(page)
            except LoginRequired:
                raise  # cookie hết hạn → lỗi chí mạng, để watcher báo trạng thái
            except Exception:  # noqa: BLE001 — 1 group hỏng KHÔNG được làm sập cả bot
                log.warning("Không mở được thread %s — bỏ qua, sẽ thử lại lần refresh sau", thread_id, exc_info=True)
                try:
                    await page.close()
                except Exception:  # noqa: BLE001
                    pass
                continue
            self.pages[thread_id] = page
            log.info("Đã mở thread %s", thread_id)
        if config.ROVER_ENABLED:
            # Tab rover đậu blank — chỉ tốn RAM khi thực sự ghé thread nào đó.
            self._rover = await self._context.new_page()
            log.info("Rover sẵn sàng (tuần tra mỗi %.0fs)", config.ROVER_INTERVAL_SECONDS)

    def has_dedicated(self, thread_id: str) -> bool:
        return thread_id in self.pages

    async def list_sidebar_threads(self) -> list[str]:
        """ID các thread trong sidebar (thứ tự hiển thị) — đọc từ tab cố định đầu tiên."""
        page = next(iter(self.pages.values()), None)
        if page is None:
            return []
        try:
            ids = await page.evaluate(_SIDEBAR_JS)
            return ids if isinstance(ids, list) else []
        except Exception:  # noqa: BLE001 — sidebar lỗi thì coi như không thấy gì, vòng sau thử lại
            log.warning("Không đọc được sidebar", exc_info=True)
            return []

    async def refresh(self) -> None:
        """Reload nhẹ để gỡ kẹt khi trang Messenger treo/đứng (gọi định kỳ).

        Tab cố định: reload tại chỗ. Rover: xả vị trí (`_rover_at=None`) để lần ghé
        kế tiếp tự điều hướng lại — gỡ tình trạng rover đứng ở 1 chat sau ~15'."""
        for thread_id, page in self.pages.items():
            try:
                await page.reload(wait_until="domcontentloaded", timeout=60_000)
                self._check_logged_in(page)
                await self._wait_ready(page, timeout=30_000)
                await self._dismiss_overlays(page)
                log.info("[refresh] Đã reload tab %s", thread_id)
            except LoginRequired:
                raise
            except Exception:  # noqa: BLE001 — reload hỏng 1 tab thì bỏ qua, vòng sau thử lại
                log.warning("[refresh] Reload tab %s lỗi, bỏ qua", thread_id, exc_info=True)
        # Thử mở lại các tab cố định đã hỏng lúc start (chưa có trong self.pages).
        for thread_id in config.THREAD_IDS:
            if thread_id in self.pages or self._context is None:
                continue
            page = await self._context.new_page()
            try:
                await page.goto(config.thread_url(thread_id), wait_until="domcontentloaded", timeout=60_000)
                self._check_logged_in(page)
                await self._wait_ready(page, timeout=30_000)
                await self._dismiss_overlays(page)
            except LoginRequired:
                raise
            except Exception:  # noqa: BLE001 — vẫn chưa mở được thì thử lại lần refresh sau
                log.warning("[refresh] Vẫn chưa mở được thread %s", thread_id, exc_info=True)
                try:
                    await page.close()
                except Exception:  # noqa: BLE001
                    pass
                continue
            self.pages[thread_id] = page
            log.info("[refresh] Đã mở lại thread %s", thread_id)
        self._rover_at = None

    async def _ensure_rover(self, thread_id: str) -> Page:
        if self._rover is None:
            raise RuntimeError(f"Thread {thread_id} không có tab cố định và rover đang tắt")
        if self._rover_at != thread_id:
            await self._rover.goto(config.thread_url(thread_id), wait_until="domcontentloaded", timeout=60_000)
            self._check_logged_in(self._rover)
            # Timeout ngắn: thread hỏng/không tải được chỉ tốn vài giây, không chặn loop 30s.
            await self._wait_ready(self._rover, timeout=15_000)
            await self._dismiss_overlays(self._rover)
            self._rover_at = thread_id
        return self._rover

    async def _page_for(self, thread_id: str) -> Page:
        page = self.pages.get(thread_id)
        if page is not None:
            return page
        return await self._ensure_rover(thread_id)

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

    async def _wait_ready(self, page: Page, timeout: int) -> None:
        """Chờ trang vào được trạng thái ĐỌC (có khung tin hoặc ô soạn).
        KHÔNG ép ô soạn tin — thread không reply được vẫn cần đọc."""
        await page.wait_for_selector(_READY_SELECTOR, timeout=timeout)

    async def read_messages(self, thread_id: str) -> list[dict]:
        """Trả về tối đa 30 tin cuối của thread: [{sender, text, label}].

        Thread không có tab cố định → rover tự điều hướng đến (mất vài giây)."""
        page = await self._page_for(thread_id)
        self._check_logged_in(page)
        return await page.evaluate(_EXTRACT_JS)

    async def send(self, text: str, thread_id: str | None = None) -> None:
        """Gõ reply vào ô soạn tin của thread. Xuống dòng Shift+Enter, gửi Enter."""
        page = await self._page_for(thread_id or config.THREAD_ID)
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
        self._rover = None
        self._rover_at = None
