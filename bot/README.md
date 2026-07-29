# TingTing Messenger Bot (Phase 2)

Userbot Playwright đọc group chat Facebook và forward lệnh lên Worker `tingting-api`.
Kiến trúc & quyết định đầy đủ: `docs/messenger-bot-integration.md`.

**Nguyên tắc:** Python chỉ làm I/O Facebook. Mọi logic (NLU, D1, format trả lời)
nằm trong Worker `POST /api/bot/message`.

> ⚠️ Userbot vi phạm ToS Facebook — chỉ dùng **tài khoản phụ chuyên dụng**.

## Cài đặt (server Linux, Python 3.11+)

```bash
cd bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
playwright install-deps chromium   # cần sudo trên server mới

cp .env.example .env               # rồi điền giá trị
```

`.env` cần: `WORKER_URL`, `BOT_SERVICE_SECRET` (trùng secret đã đặt cho Worker),
`THREAD_ID` (lấy từ URL `messenger.com/t/<THREAD_ID>` của group chat).

## Đăng nhập Facebook (một lần, trên máy có màn hình)

```bash
python save_login.py
# Đăng nhập acc phụ trong cửa sổ browser → Enter → ra storage_state.json
```

Chạy trên máy cá nhân rồi **scp `storage_state.json` lên server** (file này
là cookie đăng nhập — không commit, đã có trong `.gitignore`).

## Chạy

```bash
python main.py            # FastAPI tại 127.0.0.1:8090 + watcher Playwright
curl localhost:8090/healthz
curl -X POST localhost:8090/send -H 'Content-Type: application/json' -d '{"text":"bot đã lên sóng"}'
```

Trong group chat, bot chỉ phản hồi tin **bắt đầu bằng `/`** (vd `/buoi`, `/help`,
`/connect <mã>`) hoặc tin **có nhắc tên bot** (`BOT_NAME`, mặc định "TingTing").

Liên kết lần đầu: admin nhóm tạo mã trên web (`POST /api/groups/:id/bot-link-code`)
rồi gõ `/connect <mã>` trong group chat.

## Server 1GB RAM — bắt buộc

```bash
# Swap 2GB
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Đã tối ưu sẵn trong code: chặn ảnh/media/font, flags `--disable-dev-shm-usage
--disable-gpu --no-sandbox --disable-extensions`, 1 tab duy nhất, restart browser
mỗi `RESTART_HOURS` (mặc định 8h).

## systemd

Dùng luôn `tingting-bot.service` trong repo:

```bash
sudo cp /opt/caulongdi/bot/tingting-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tingting-bot
journalctl -u tingting-bot -f
```

`RestartSteps`/`RestartMaxDelaySec` cần systemd ≥ 254 (Ubuntu 24.04 trở lên) — bản cũ
hơn chỉ cảnh báo "Unknown key" khi `daemon-reload`, bỏ hai dòng đó là chạy bình thường.

## Khi hỏng

- Log lặp `could not bind on any address out of [(...)]` → không chiếm được cổng, bot
  chết ngay lúc khởi động. Xem ai giữ cổng: `ss -ltnp | grep 8090`. Có tiến trình lạ →
  còn bản bot chạy tay (tmux/screen) hoặc tiến trình mồ côi, kill nó. Không ai giữ cổng
  → IP trong `API_HOST` không còn trên máy (`ip -4 addr`), sửa `.env` về `127.0.0.1`
  (hoặc `0.0.0.0` nếu cần gọi từ LAN — nhớ `/send` không có xác thực).
- `/healthz` trả `status: login_required` → cookie hết hạn, chạy lại `save_login.py` và scp lên.
- Bot không thấy tin mới / không gửi được → FB đổi DOM; mọi selector nằm trong
  `messenger.py` (`_EXTRACT_JS`, `_TEXTBOX_SELECTOR`) — sửa ở đó, đặt `HEADLESS=false` để debug.
- Worker trả lỗi → xem log `worker_client`, kiểm tra `BOT_SERVICE_SECRET` và `wrangler tail`.
