# 🏸 Cầu Lông Đội

Web app quản lý lịch chơi cầu lông cho nhóm: check-in thành viên, chia tiền sân/nước/cầu, theo dõi công nợ, thống kê tham gia.

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
npx wrangler d1 create badminton-db
```

Copy `database_id` từ output, paste vào `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "badminton-db"
database_id = "PASTE_YOUR_ID_HERE"
```

### 3. Chạy schema migration

```bash
npx wrangler d1 execute badminton-db --local --file=src/db/schema.sql
```

### 4. Tạo file secrets cho local dev

Tạo file `worker/.dev.vars`:

```env
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
BETTER_AUTH_SECRET=any_random_string_32chars_minimum
FRONTEND_URL=http://localhost:5173
```

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
npx wrangler d1 create badminton-db
npx wrangler d1 execute badminton-db --file=src/db/schema.sql
```

### Bước 2 — Set secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BETTER_AUTH_SECRET
```

> `BETTER_AUTH_SECRET` có thể là bất kỳ chuỗi random nào, tối thiểu 32 ký tự.
> Tạo nhanh: `openssl rand -base64 32`

### Bước 3 — Deploy Worker

```bash
npx wrangler deploy
```

Sau khi deploy xong, Wrangler sẽ in ra URL worker dạng:
`https://badminton-api.your-subdomain.workers.dev`

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
npx wrangler pages deploy frontend/dist --project-name=badminton-manager
```

### Bước 5 — Cập nhật config sau khi có domain

Sau khi có domain Pages (vd: `https://badminton-manager.pages.dev`), cập nhật `worker/wrangler.toml`:

```toml
[vars]
FRONTEND_URL = "https://badminton-manager.pages.dev"
```

Rồi deploy lại worker:

```bash
npx wrangler deploy
```

### Bước 6 — Cập nhật Google Console

Thêm vào Google Cloud Console → **Authorized JavaScript origins**:
```
https://badminton-manager.pages.dev
```

Thêm vào **Authorized redirect URIs**:
```
https://badminton-api.your-subdomain.workers.dev/api/auth/callback/google
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

GET    /api/stats                   Tổng hợp thống kê
```

---

## Checklist trước khi go-live

- [ ] Tạo Google Cloud Console project, bật Google OAuth API
- [ ] Lấy `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`
- [ ] Chạy `wrangler d1 create` và schema migration
- [ ] Set 3 secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`
- [ ] Cập nhật `FRONTEND_URL` trong `wrangler.toml`
- [ ] Deploy worker và frontend
- [ ] Thêm domain vào Google Console (origins + redirect URI)
- [ ] Test đăng nhập Google
- [ ] Kiểm tra user đầu tiên có `role = admin`
- [ ] Invite các thành viên trong nhóm vào link Pages
