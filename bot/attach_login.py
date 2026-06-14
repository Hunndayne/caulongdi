"""Lưu cookie FB bằng cách GẮN VÀO Chrome thật (không bị automation chặn 2FA).

Vì sao: FB không render trang 2FA cho trình duyệt do Playwright điều khiển. Cách
vòng: bạn tự mở 1 cửa sổ Chrome bật cổng debug, đăng nhập + 2FA như người thật,
rồi script này chỉ kết nối vào để hút storage_state — Chrome vẫn là "người dùng".

Các bước (Windows):
  1) Đóng bớt cũng được, KHÔNG cần đóng Chrome chính (ta dùng profile riêng).
  2) Mở Chrome có cổng debug + profile riêng:
       "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ^
         --remote-debugging-port=9222 ^
         --user-data-dir="C:\\Users\\%USERNAME%\\fb-bot-profile"
     (nếu Chrome ở chỗ khác, sửa lại đường dẫn)
  3) Trong cửa sổ Chrome đó: vào https://www.messenger.com/ , đăng nhập tài
     khoản phụ, làm 2FA cho tới khi thấy danh sách chat.
  4) Chạy: python attach_login.py  → bấm Enter để lưu cookie.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv(Path(__file__).parent / ".env")
STORAGE_STATE = str(Path(__file__).parent / os.getenv("STORAGE_STATE", "storage_state.json"))
CDP_URL = os.getenv("CDP_URL", "http://localhost:9222")


def main() -> None:
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(
                f"Không kết nối được Chrome ở {CDP_URL}.\n"
                "Bạn đã mở Chrome với --remote-debugging-port=9222 chưa? "
                "Xem hướng dẫn ở đầu file."
            ) from exc

        contexts = browser.contexts
        if not contexts:
            raise SystemExit("Chrome chưa có cửa sổ/tab nào — mở messenger.com trong Chrome đó trước.")
        context = contexts[0]

        # Liệt kê tab để bạn chắc đang đúng cửa sổ.
        for page in context.pages:
            print("Tab:", page.url)

        input("\n>> Đăng nhập messenger.com xong (thấy danh sách chat) thì bấm Enter để lưu cookie... ")
        context.storage_state(path=STORAGE_STATE)
        print(f"Đã lưu cookie vào {STORAGE_STATE}")
        # KHÔNG browser.close() — để Chrome của bạn nguyên vẹn, chỉ ngắt kết nối.


if __name__ == "__main__":
    main()
