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
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://www.messenger.com/")
        input("\n>> Đăng nhập xong (thấy danh sách chat) thì bấm Enter ở đây để lưu cookie... ")
        context.storage_state(path=STORAGE_STATE)
        print(f"Đã lưu cookie vào {STORAGE_STATE}")
        browser.close()


if __name__ == "__main__":
    main()
