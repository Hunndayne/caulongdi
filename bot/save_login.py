"""Đăng nhập Facebook MỘT LẦN (bằng tài khoản phụ) để lưu cookie cho bot.

Chạy: python save_login.py
Mở cửa sổ browser → tự đăng nhập messenger.com (kể cả 2FA) → quay lại
terminal bấm Enter → cookie lưu vào STORAGE_STATE (mặc định storage_state.json).
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

# Không import config — bước này chỉ cần STORAGE_STATE, chưa cần secret/thread.
load_dotenv(Path(__file__).parent / ".env")
STORAGE_STATE = str(Path(__file__).parent / os.getenv("STORAGE_STATE", "storage_state.json"))


def main() -> None:
    with sync_playwright() as p:
        # FB hay trả trang 2FA TRẮNG cho Chromium bundled của Playwright (bị nhận diện
        # automation). Dùng Google Chrome thật + tắt cờ AutomationControlled → render đúng.
        launch_args = ["--disable-blink-features=AutomationControlled"]
        try:
            browser = p.chromium.launch(headless=False, channel="chrome", args=launch_args)
            print("Đang dùng Google Chrome thật.")
        except Exception:  # noqa: BLE001 — máy chưa cài Chrome thì lùi về Chromium bundled
            print("Không thấy Google Chrome — dùng Chromium bundled (2FA có thể bị trắng trang).")
            browser = p.chromium.launch(headless=False, args=launch_args)
        # UA + viewport như người thật; giấu navigator.webdriver để FB bớt nghi.
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
        )
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = context.new_page()
        page.goto("https://www.messenger.com/")
        input("\n>> Đăng nhập xong (thấy danh sách chat) thì bấm Enter ở đây để lưu cookie... ")
        context.storage_state(path=STORAGE_STATE)
        print(f"Đã lưu cookie vào {STORAGE_STATE}")
        browser.close()


if __name__ == "__main__":
    main()
