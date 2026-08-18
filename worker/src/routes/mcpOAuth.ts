// OAuth 2.1 authorization server tối giản cho MCP — để connector web (ChatGPT, Claude.ai,
// Gemini web) kết nối /mcp. Các connector này bắt buộc OAuth, không nhận Bearer token tĩnh.
//
// Hỗ trợ: discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591),
// authorization_code + PKCE S256 (bắt buộc), refresh_token. Public client (không secret).
// Bước đăng nhập dựa vào session Better Auth sẵn có (cookie trên caulong.hunn.io.vn).

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { createAuth } from "../auth";
import { ensureMcpTables } from "../db/mcpTables";

const ACCESS_TTL_SECONDS = 3600; // 1 giờ
const CODE_TTL_MS = 5 * 60 * 1000; // 5 phút
const SCOPE = "mcp";

function originOf(c: Context<{ Bindings: Env }>): string {
  return new URL(c.req.url).origin;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(prefix: string): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256B64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getSessionUserId(c: Context<{ Bindings: Env }>): Promise<string | null> {
  try {
    const auth = createAuth(c.env, c.req.raw);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// Trang HTML gọn cho bước authorize (đăng nhập / đồng ý). Không phụ thuộc frontend SPA.
function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f0fdf4;margin:0;
       display:flex;min-height:100vh;align-items:center;justify-content:center;color:#111827}
  .card{background:#fff;max-width:420px;width:calc(100% - 32px);padding:28px;border-radius:16px;
        box-shadow:0 10px 40px rgba(0,0,0,.08)}
  h1{font-size:20px;margin:0 0 8px} p{color:#4b5563;font-size:14px;line-height:1.5}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700;color:#16a34a;margin-bottom:16px}
  .brand span{width:14px;height:14px;border-radius:50%;background:#16a34a;display:inline-block}
  .row{display:flex;gap:10px;margin-top:20px}
  button,a.btn{flex:1;text-align:center;padding:11px 14px;border-radius:10px;border:0;font-size:15px;
        font-weight:600;cursor:pointer;text-decoration:none}
  .primary{background:#16a34a;color:#fff} .ghost{background:#f3f4f6;color:#374151}
  code{background:#f3f4f6;padding:1px 6px;border-radius:6px;font-size:13px}
</style></head><body><div class="card">
<div class="brand"><span></span>TingTing</div>${bodyHtml}</div></body></html>`;
}

// Redirect lỗi về client theo đúng spec (chỉ khi redirect_uri đã hợp lệ).
function errorRedirect(redirectUri: string, error: string, state: string | undefined, description?: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return Response.redirect(u.toString(), 302);
}

type ClientRow = { client_id: string; redirect_uris: string; client_name: string };

async function loadClient(env: Env, clientId: string): Promise<ClientRow | null> {
  if (!clientId) return null;
  return env.DB.prepare("SELECT client_id, redirect_uris, client_name FROM mcp_oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<ClientRow>();
}

function clientRedirectUris(row: ClientRow): string[] {
  try {
    const arr = JSON.parse(row.redirect_uris);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ================= Discovery (mount tại /.well-known) =================

export const oauthWellKnown = new Hono<{ Bindings: Env }>();

// RFC 9728 — protected resource metadata. Client fetch cái này (từ WWW-Authenticate) để biết AS.
const protectedResource = (c: Context<{ Bindings: Env }>) => {
  const origin = originOf(c);
  return c.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
  });
};
oauthWellKnown.get("/oauth-protected-resource", protectedResource);
// Biến thể chèn path (khi resource có path /mcp) mà một số client dùng.
oauthWellKnown.get("/oauth-protected-resource/mcp", protectedResource);

// RFC 8414 — authorization server metadata.
const authServerMetadata = (c: Context<{ Bindings: Env }>) => {
  const origin = originOf(c);
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
};
oauthWellKnown.get("/oauth-authorization-server", authServerMetadata);
oauthWellKnown.get("/oauth-authorization-server/mcp", authServerMetadata);
// Một số client thử luôn openid-configuration.
oauthWellKnown.get("/openid-configuration", authServerMetadata);

// ================= OAuth endpoints (mount tại /oauth) =================

export const oauthRoutes = new Hono<{ Bindings: Env }>();

// --- Dynamic Client Registration (RFC 7591) ---
oauthRoutes.post("/register", async (c) => {
  await ensureMcpTables(c.env.DB);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const uris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as unknown[]).filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x))
    : [];
  if (!uris.length) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris là bắt buộc" }, 400);
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "";
  const clientId = randomToken("ttmc_");
  await c.env.DB.prepare(
    "INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(clientId, clientName, JSON.stringify(uris), new Date().toISOString())
    .run();
  return c.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201
  );
});

// --- Authorization endpoint (GET): đăng nhập + đồng ý ---
oauthRoutes.get("/authorize", async (c) => {
  await ensureMcpTables(c.env.DB);
  const q = c.req.query();
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const state = q.state;

  const client = await loadClient(c.env, clientId);
  // redirect_uri không hợp lệ -> KHÔNG được redirect (tránh open redirect); hiện lỗi tại chỗ.
  if (!client || !clientRedirectUris(client).includes(redirectUri)) {
    return c.html(
      page("Kết nối không hợp lệ", `<h1>Không kết nối được</h1><p>Ứng dụng gửi <code>client_id</code> hoặc <code>redirect_uri</code> không hợp lệ. Hãy thử thêm lại connector.</p>`),
      400
    );
  }

  if ((q.response_type ?? "") !== "code") {
    return errorRedirect(redirectUri, "unsupported_response_type", state);
  }
  if (!q.code_challenge || (q.code_challenge_method ?? "") !== "S256") {
    return errorRedirect(redirectUri, "invalid_request", state, "Yêu cầu PKCE S256");
  }

  const userId = await getSessionUserId(c);
  if (!userId) {
    // Chưa đăng nhập TingTing trên trình duyệt này -> hướng dẫn đăng nhập rồi thử lại.
    const retry = escapeHtml(c.req.url);
    const appUrl = escapeHtml(`${originOf(c)}/`);
    return c.html(
      page(
        "Cần đăng nhập TingTing",
        `<h1>Đăng nhập TingTing trước</h1>
         <p>Để cấp quyền cho ứng dụng AI, bạn cần đăng nhập TingTing trên chính trình duyệt này.</p>
         <div class="row">
           <a class="btn primary" href="${appUrl}" target="_blank" rel="noopener">Mở &amp; đăng nhập TingTing</a>
           <a class="btn ghost" href="${retry}">Đã đăng nhập, thử lại</a>
         </div>`
      ),
      200
    );
  }

  // Đã đăng nhập -> trang đồng ý. Mọi tham số gói vào form POST /oauth/authorize/decision.
  const fields: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: q.code_challenge,
    code_challenge_method: "S256",
    scope: q.scope ?? SCOPE,
    state: state ?? "",
    resource: q.resource ?? "",
  };
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}"/>`)
    .join("");
  const clientLabel = escapeHtml(client.client_name || "Ứng dụng AI");
  return c.html(
    page(
      "Cấp quyền truy cập",
      `<h1>Cho phép truy cập?</h1>
       <p><strong>${clientLabel}</strong> muốn dùng dữ liệu TingTing của bạn (xem lịch, chi phí, công nợ và tạo buổi/ghi chi phí) thay bạn.</p>
       <form method="POST" action="${escapeHtml(`${originOf(c)}/oauth/authorize/decision`)}">
         ${hidden}
         <div class="row">
           <button class="primary" type="submit" name="decision" value="allow">Cho phép</button>
           <button class="ghost" type="submit" name="decision" value="deny">Từ chối</button>
         </div>
       </form>`
    ),
    200
  );
});

// --- Authorization decision (POST): phát mã uỷ quyền ---
oauthRoutes.post("/authorize/decision", async (c) => {
  await ensureMcpTables(c.env.DB);
  const form = await c.req.parseBody();
  const get = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state") || undefined;

  const client = await loadClient(c.env, clientId);
  if (!client || !clientRedirectUris(client).includes(redirectUri)) {
    return c.html(page("Kết nối không hợp lệ", `<h1>Không kết nối được</h1><p>Thông tin ứng dụng không hợp lệ.</p>`), 400);
  }

  const userId = await getSessionUserId(c);
  if (!userId) {
    return errorRedirect(redirectUri, "access_denied", state, "Phiên đăng nhập đã hết");
  }
  if (get("decision") !== "allow") {
    return errorRedirect(redirectUri, "access_denied", state);
  }
  const codeChallenge = get("code_challenge");
  if (!codeChallenge) {
    return errorRedirect(redirectUri, "invalid_request", state, "Thiếu PKCE");
  }

  const code = randomToken("ttac_");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO mcp_oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(code),
      clientId,
      userId,
      redirectUri,
      codeChallenge,
      get("scope") || SCOPE,
      get("resource") || null,
      new Date(now + CODE_TTL_MS).toISOString(),
      new Date(now).toISOString()
    )
    .run();

  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return Response.redirect(u.toString(), 302);
});

// --- Token endpoint (POST): đổi code -> token, hoặc refresh ---
type TokenRow = {
  access_hash: string;
  refresh_hash: string | null;
  user_id: string;
  client_id: string;
  scope: string;
};

oauthRoutes.post("/token", async (c) => {
  await ensureMcpTables(c.env.DB);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const get = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const grantType = get("grant_type");

  const issueTokens = async (userId: string, clientId: string, scope: string) => {
    const access = randomToken("ttoat_");
    const refresh = randomToken("ttort_");
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO mcp_oauth_tokens (access_hash, refresh_hash, user_id, client_id, scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        await sha256Hex(access),
        await sha256Hex(refresh),
        userId,
        clientId,
        scope,
        new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString(),
        new Date(now).toISOString()
      )
      .run();
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope,
    });
  };

  if (grantType === "authorization_code") {
    const code = get("code");
    const redirectUri = get("redirect_uri");
    const clientId = get("client_id");
    const verifier = get("code_verifier");
    if (!code || !verifier) return c.json({ error: "invalid_request" }, 400);

    const row = await c.env.DB.prepare(
      `SELECT client_id, user_id, redirect_uri, code_challenge, scope, expires_at, consumed_at
       FROM mcp_oauth_codes WHERE code_hash = ?`
    )
      .bind(await sha256Hex(code))
      .first<{
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string;
        expires_at: string;
        consumed_at: string | null;
      }>();

    if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
      return c.json({ error: "invalid_grant", error_description: "Mã không hợp lệ hoặc đã hết hạn" }, 400);
    }
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return c.json({ error: "invalid_grant", error_description: "client_id/redirect_uri không khớp" }, 400);
    }
    // PKCE: challenge phải bằng base64url(sha256(verifier)).
    if ((await sha256B64Url(verifier)) !== row.code_challenge) {
      return c.json({ error: "invalid_grant", error_description: "PKCE không khớp" }, 400);
    }
    // Đánh dấu dùng rồi (một lần).
    await c.env.DB.prepare("UPDATE mcp_oauth_codes SET consumed_at = ? WHERE code_hash = ?")
      .bind(new Date().toISOString(), await sha256Hex(code))
      .run();
    return issueTokens(row.user_id, row.client_id, row.scope);
  }

  if (grantType === "refresh_token") {
    const refresh = get("refresh_token");
    if (!refresh) return c.json({ error: "invalid_request" }, 400);
    const row = await c.env.DB.prepare(
      "SELECT access_hash, refresh_hash, user_id, client_id, scope FROM mcp_oauth_tokens WHERE refresh_hash = ? AND revoked_at IS NULL"
    )
      .bind(await sha256Hex(refresh))
      .first<TokenRow>();
    if (!row) return c.json({ error: "invalid_grant" }, 400);
    // Cấp access token mới trên cùng bản ghi (giữ nguyên refresh token).
    const access = randomToken("ttoat_");
    await c.env.DB.prepare(
      "UPDATE mcp_oauth_tokens SET access_hash = ?, expires_at = ? WHERE refresh_hash = ?"
    )
      .bind(
        await sha256Hex(access),
        new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
        row.refresh_hash
      )
      .run();
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope: row.scope,
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});
