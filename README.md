# TingTing

Web app quản lý lịch hẹn cho nhóm: check-in thành viên, chia chi phí, theo dõi công nợ, thống kê tham gia.

## Tech Stack

| Layer | Công nghệ |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS v4 |
| Backend | Cloudflare Workers + Hono |
| Database | Cloudflare D1 (SQLite at edge) |
| Auth | Better Auth + Google OAuth 2.0 |
| State | Zustand |
| Deploy | Cloudflare Pages (frontend) + Workers (API) |

**Hoàn toàn miễn phí** trong Cloudflare free tier: Workers 100k req/ngày, D1 5GB.

---

## Chạy local

### Yêu cầu

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- Wrangler CLI (`npm install -g wrangler`)
- Tài khoản Cloudflare (miễn phí)
- Google Cloud Console project với OAuth 2.0 credentials

### 1. Clone và cài dependencies

```bash
git clone <repo-url>
cd caulongdi
pnpm install
```

### 2. Tạo D1 database local

```bash
cd worker
npx wrangler d1 create tingting-db
```

Copy `database_id` từ output, paste vào `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tingting-db"
database_id = "PASTE_YOUR_ID_HERE"
```

### 3. Chạy schema migration

```bash
npx wrangler d1 execute tingting-db --local --file=src/db/schema.sql
```

Rồi các patch bổ sung, trong đó có hũ Timo (tự xác nhận thanh toán):

```bash
pnpm db:patch:timo-pot     # cột groups.timo_* + bảng timo_seen_txn
```

### 4. Tạo file secrets cho local dev

Tạo file `worker/.dev.vars`:

```env
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
BETTER_AUTH_SECRET=any_random_string_32chars_minimum
FRONTEND_URL=http://localhost:5173

# (legacy, tuỳ chọn) chỉ cần nếu còn chạy webhook Gmail cũ — xem mục Tự xác nhận thanh toán
PAYMENT_WEBHOOK_SECRET=another_random_string_32chars_minimum
```

> Tính năng **tự xác nhận thanh toán qua hũ Timo** không cần secret/env nào — cấu hình nằm trong
> D1 theo từng nhóm. Chỉ cần chạy migration `patch-timo-pot.sql` (xem bên dưới).

### 5. Khởi động

Mở 2 terminal:

```bash
# Terminal 1 — Worker API (port 8787)
pnpm --filter worker dev

# Terminal 2 — Frontend (port 5173)
pnpm --filter frontend dev
```

Truy cập: http://localhost:5173

---

## Lấy Google OAuth Credentials

1. Vào [Google Cloud Console](https://console.cloud.google.com/)
2. Tạo project mới hoặc chọn project có sẵn
3. Vào **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Application type: **Web application**
5. Thêm Authorized JavaScript origins:
   - `http://localhost:5173`
   - `https://your-pages.pages.dev` (sau khi có domain)
6. Thêm Authorized redirect URIs:
   - `http://localhost:8787/api/auth/callback/google`
   - `https://your-worker.workers.dev/api/auth/callback/google`
7. Copy **Client ID** và **Client Secret**

---

## Deploy lên Cloudflare

### Bước 1 — Tạo D1 database production

```bash
cd worker
npx wrangler d1 create tingting-db
npx wrangler d1 execute tingting-db --file=src/db/schema.sql
pnpm db:patch:timo-pot:prod      # hũ Timo: cột groups.timo_* + bảng timo_seen_txn
```

### Bước 2 — Set secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BETTER_AUTH_SECRET

# (legacy) chỉ khi còn chạy webhook Gmail cũ trong giai đoạn chuyển đổi
npx wrangler secret put PAYMENT_WEBHOOK_SECRET
```

> `BETTER_AUTH_SECRET` có thể là bất kỳ chuỗi random nào, tối thiểu 32 ký tự.
> Tạo nhanh: `openssl rand -base64 32`
> `PAYMENT_WEBHOOK_SECRET` là chuỗi bí mật dùng cho Google Apps Script gọi webhook thanh toán —
> **chỉ thuộc đường legacy**. Đường chính (hũ Timo) không cần secret nào, cấu hình nằm trong D1
> theo từng nhóm.

### Bước 3 — Deploy Worker

```bash
npx wrangler deploy
```

Sau khi deploy xong, Wrangler sẽ in ra URL worker dạng:
`https://tingting-api.your-subdomain.workers.dev`

### Bước 4 — Deploy Frontend lên Cloudflare Pages

**Cách 1 — Dùng GitHub (khuyến nghị):**

1. Push code lên GitHub
2. Vào [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Pages → Create a project → Connect to Git**
3. Chọn repo, cấu hình build:

| Setting | Value |
|---|---|
| Build command | `pnpm --filter frontend build` |
| Build output directory | `frontend/dist` |
| Root directory | *(để trống)* |
| Node.js version | `18` |

4. Click **Save and Deploy**

**Cách 2 — Deploy trực tiếp:**

```bash
pnpm --filter frontend build
npx wrangler pages deploy frontend/dist --project-name=tingting
```

### Bước 5 — Cập nhật config sau khi có domain

Sau khi có domain Pages (vd: `https://tingting.pages.dev`), cập nhật `worker/wrangler.toml`:

```toml
[vars]
FRONTEND_URL = "https://tingting.pages.dev"
```

Rồi deploy lại worker:

```bash
npx wrangler deploy
```

### Bước 6 — Cập nhật Google Console

Thêm vào Google Cloud Console → **Authorized JavaScript origins**:
```
https://tingting.pages.dev
```

Thêm vào **Authorized redirect URIs**:
```
https://tingting-api.your-subdomain.workers.dev/api/auth/callback/google
```

---

## Cấu trúc thư mục

```
caulongdi/
├── frontend/
│   ├── src/
│   │   ├── api/client.ts          # Typed fetch wrapper
│   │   ├── components/
│   │   │   ├── ui/                # Button, Input, Dialog, Badge
│   │   │   └── shared/            # Avatar, Navbar, EmptyState
│   │   ├── lib/
│   │   │   ├── auth-client.ts     # Better Auth React client
│   │   │   └── utils.ts           # cn, formatCurrency, formatDate
│   │   ├── pages/                 # 7 trang
│   │   ├── stores/                # Zustand stores
│   │   └── types/index.ts         # TypeScript types
│   └── vite.config.ts
│
├── worker/
│   ├── src/
│   │   ├── index.ts               # Hono app + auth middleware
│   │   ├── auth.ts                # Better Auth setup
│   │   ├── routes/                # members, sessions, payments, stats
│   │   ├── db/schema.sql          # Database schema
│   │   ├── types.ts               # Env bindings + type augmentation
│   │   └── utils.ts               # nanoid
│   └── wrangler.toml
│
└── package.json                   # pnpm workspace root
```

---

## Phân quyền

User đầu tiên đăng ký **tự động được set `role = admin`**.

| Hành động | Member | Admin |
|---|:---:|:---:|
| Xem buổi chơi | ✅ | ✅ |
| Check-in, toggle thanh toán | ✅ | ✅ |
| Tạo / xóa buổi, thêm thành viên | ❌ | ✅ |
| Nhập chi phí, tính lại tiền | ❌ | ✅ |

---

## API Endpoints

```
GET  /api/auth/signin/google        Redirect Google OAuth
GET  /api/auth/callback/google      Xử lý callback
GET  /api/auth/session              User hiện tại

GET    /api/members                 Danh sách thành viên
POST   /api/members                 Tạo mới (admin)
PUT    /api/members/:id             Cập nhật (admin)
DELETE /api/members/:id             Xóa (admin)

GET    /api/sessions                Danh sách buổi chơi
POST   /api/sessions                Tạo buổi (admin)
GET    /api/sessions/:id            Chi tiết (members + costs + payments)
PUT    /api/sessions/:id            Cập nhật (admin)
DELETE /api/sessions/:id            Xóa (admin)
POST   /api/sessions/:id/members    Set check-in list (admin)
POST   /api/sessions/:id/costs      Thêm khoản chi (admin)
DELETE /api/sessions/:id/costs/:cid Xóa khoản chi (admin)
POST   /api/sessions/:id/recalculate Tính lại payments (admin)

POST   /api/payments/:id/toggle     Toggle đã trả / chưa trả

GET    /api/groups/:id/timo-pot         Trạng thái hũ Timo của nhóm (admin nhóm)
PUT    /api/groups/:id/timo-pot         Lưu link + mật mã hũ (admin nhóm)
DELETE /api/groups/:id/timo-pot         Bỏ cấu hình hũ (admin nhóm)
POST   /api/groups/:id/timo-pot/check   "Kiểm tra ngay" (mọi thành viên, throttle 15s)

POST   /api/payment-webhooks/bank-transfer  Auto-confirm QR payment webhook (legacy, Gmail)

GET    /api/stats                   Tổng hợp thống kê
```

---

## Tự xác nhận thanh toán

### Cách chính — hũ (money pot) Timo, theo từng nhóm

Trưởng nhóm tạo **hũ** trong app Timo, bật link chia sẻ lịch sử giao dịch, rồi dán link + mật mã
bảo vệ vào **Cài đặt nhóm** trên web. Worker cron (10 phút/lần, `[triggers] crons` trong
`worker/wrangler.toml`) đọc lịch sử giao dịch của từng hũ và tự đánh dấu payment đã trả khi nội
dung chuyển khoản chứa mã `CLD-<paymentId>` và số tiền khớp. Thành viên có thể bấm **Kiểm tra
ngay** để không phải chờ hết nhịp cron.

Nhóm nào cũng dùng được, **không phụ thuộc hộp thư của ai**. Không cần secret/env mới — cấu hình
nằm trong D1 theo nhóm (`groups.timo_*`).

**Điều kiện quan trọng:** số tài khoản ngân hàng mà người thu tiền khai trong TingTing phải là số
tài khoản **của hũ**. Khai tài khoản chính thì lịch sử hũ không thấy giao dịch → không bao giờ tự
xác nhận được.

Chuẩn bị một lần cho toàn hệ thống:

```bash
cd worker
pnpm db:patch:timo-pot:prod    # cột groups.timo_* + bảng timo_seen_txn
```

📖 **Chi tiết đầy đủ** (contract API Timo, schema, các tầng kiểm tra, hướng dẫn thiết lập từng
bước, checklist chẩn đoán khi không xác nhận được, rủi ro): [`docs/timo-pot-autoconfirm.md`](docs/timo-pot-autoconfirm.md)

### Cách cũ — Google Apps Script quét Gmail (LEGACY, sẽ bỏ)

> ⚠️ **Deprecated.** Chỉ còn chạy song song trong giai đoạn chuyển đổi, cho nhóm chưa cấu hình hũ
> Timo. Hai nhược điểm khiến nó bị thay: (a) chỉ chạy được với **một hộp thư duy nhất**
> (`PAYMENT_AUTOCONFIRM_EMAIL`) nên chỉ nhóm có người đó thu tiền mới tự xác nhận được;
> (b) `GmailApp.search(query, 0, 20)` chỉ quét 20 thread mỗi lần → hộp thư nhiều mail là bỏ lỡ
> giao dịch mà không báo lỗi. Khi mọi nhóm đã chuyển sang hũ Timo: xoá script, xoá route
> `/api/payment-webhooks/bank-transfer`, bỏ `PAYMENT_WEBHOOK_SECRET` và `PAYMENT_AUTOCONFIRM_EMAIL`.

Script mẫu nằm ở `scripts/timo-gmail-webhook.gs`.

1. Tạo một Google Apps Script gắn với Gmail của người đứng thu tiền.
2. Dán nội dung file script vào Apps Script.
3. Thay `PASTE_PAYMENT_WEBHOOK_SECRET_HERE` bằng đúng secret đã set trong Worker qua `PAYMENT_WEBHOOK_SECRET`.
4. Tạo trigger chạy hàm `scanTimoPaymentEmails` mỗi 1-5 phút.

Webhook production cố định:

```txt
https://caulong.hunn.io.vn/api/payment-webhooks/bank-transfer
```

Script chỉ gửi email Timo có dòng tiền vào `vừa tăng ... VND`, có `Mô tả: ...`, và phần mô tả chứa mã `TT-<paymentId>` hoặc `CLD-<paymentId>` được nhúng trong QR.

Cả hai đường dùng chung lõi xác nhận `worker/src/paymentConfirm.ts` nên không xác nhận trùng nhau.

---


Dùng `attach_login.py` theo flow này nhé:

1. Mở Chrome riêng có debug port:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\fb-bot-profile"
```

2. Trong cửa sổ Chrome vừa mở, vào:

```text
https://www.messenger.com/
```

Đăng nhập acc phụ, làm 2FA xong, chờ tới khi thấy danh sách chat.

3. Mở terminal khác rồi chạy bằng đúng venv của `bot`:

```powershell
cd D:\code\caulongdi\bot
.\.venv\Scripts\python.exe .\attach_login.py
```

Script sẽ in các tab đang mở. Nếu thấy tab Messenger đúng rồi thì bấm `Enter`; nó sẽ lưu cookie vào:

```text
D:\code\caulongdi\bot\storage_state.json
```

Sau đó bot dùng file này khi chạy `main.py`.


## Checklist trước khi go-live

- [ ] Tạo Google Cloud Console project, bật Google OAuth API
- [ ] Lấy `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`
- [ ] Chạy `wrangler d1 create` và schema migration
- [ ] Chạy migration hũ Timo: `pnpm db:patch:timo-pot:prod`
- [ ] Set 3 secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`
      (+ `PAYMENT_WEBHOOK_SECRET` chỉ nếu còn chạy webhook Gmail legacy)
- [ ] Cập nhật `FRONTEND_URL` trong `wrangler.toml`
- [ ] Kiểm tra `[triggers] crons` còn trong `wrangler.toml` (nhắc kèo + đối soát hũ Timo)
- [ ] Deploy worker và frontend
- [ ] Thêm domain vào Google Console (origins + redirect URI)
- [ ] Test đăng nhập Google
- [ ] Kiểm tra user đầu tiên có `role = admin`
- [ ] Invite các thành viên trong nhóm vào link Pages
- [ ] Mỗi trưởng nhóm: cấu hình hũ Timo trong Cài đặt nhóm + khai số tài khoản **của hũ** cho
      người thu tiền, rồi test 1 giao dịch thật ([`docs/timo-pot-autoconfirm.md`](docs/timo-pot-autoconfirm.md))



