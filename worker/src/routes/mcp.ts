// MCP server (Streamable HTTP, stateless) — cho các app AI ngoài (Claude Desktop,
// ChatGPT, Cursor...) gọi tool của TingTing bằng Bearer token sinh trong trang Hồ sơ.
//
// Tái dụng nguyên layer tool của agent Messenger: buildTools()/executeTool() trong
// botAgent.ts, lọc theo allowlist (tra cứu + tạo buổi/ghi khoản chi) và bơm thêm
// tham số "group" để chọn nhóm khi user thuộc nhiều nhóm.

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { ensureMcpTables } from "../db/mcpTables";
import { buildTools, executeTool, type RunAgentArgs } from "./botAgent";
import { vnNow } from "./bot";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

// v1: tra cứu + thao tác ghi an toàn (tạo buổi, ghi chi phí, thêm người vào buổi).
// Chưa mở sửa/xoá chi phí, huỷ buổi, mark_paid, rút thành viên.
const MCP_TOOL_ALLOWLIST = new Set([
  "find_sessions",
  "get_session_attendees",
  "list_members",
  "get_costs",
  "get_member_debts",
  "get_stats",
  "create_session",
  "add_cost",
  "add_members",
]);

const GROUP_PARAM = {
  type: "string",
  description: 'Tên nhóm cần thao tác. Bỏ trống nếu bạn chỉ thuộc một nhóm.',
};

type MembershipRow = {
  group_id: string;
  group_name: string;
  member_id: string | null;
  member_name: string | null;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Xác thực: Bearer ttmcp_... -> user (token lưu hash, thu hồi tức thì qua revoked_at) ---
// Token đến từ header Authorization (chuẩn, ưu tiên) hoặc path /mcp/<token> — cho các app
// không đặt được custom header (Gemini, ChatGPT connectors...). Lưu ý: token trong path
// sẽ hiện trong access log của Cloudflare nếu bật observability.

// Token tĩnh (ttmcp_, sinh ở /api/mcp-tokens) HOẶC access token OAuth (ttoat_, sinh ở /oauth/token).
function extractToken(authorization: string | undefined, pathToken?: string): string | null {
  const header = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  for (const t of [header, pathToken]) {
    if (t && (t.startsWith("ttmcp_") || t.startsWith("ttoat_"))) return t;
  }
  return null;
}

async function resolveToken(
  env: Env,
  authorization: string | undefined,
  pathToken?: string
): Promise<{ userId: string; tokenHash: string; kind: "static" | "oauth" } | null> {
  const token = extractToken(authorization, pathToken);
  if (!token) return null;
  await ensureMcpTables(env.DB);
  const tokenHash = await sha256Hex(token);

  if (token.startsWith("ttmcp_")) {
    const row = await env.DB.prepare(
      "SELECT user_id FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL"
    )
      .bind(tokenHash)
      .first<{ user_id: string }>();
    return row ? { userId: row.user_id, tokenHash, kind: "static" } : null;
  }

  // OAuth access token: phải chưa thu hồi và còn hạn.
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at FROM mcp_oauth_tokens WHERE access_hash = ? AND revoked_at IS NULL"
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: string }>();
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return { userId: row.user_id, tokenHash, kind: "oauth" };
}

async function touchLastUsed(env: Env, tokenHash: string) {
  await env.DB.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(vnNow().toISOString(), tokenHash)
    .run();
}

// --- Resolve nhóm + danh tính thành viên của user ---

async function loadMemberships(env: Env, userId: string): Promise<MembershipRow[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id AS group_id, g.name AS group_name, m.id AS member_id, m.name AS member_name
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
     LEFT JOIN members m ON m.group_id = g.id AND m.user_id = ? AND m.is_active = 1
     ORDER BY g.name COLLATE NOCASE`
  )
    .bind(userId, userId)
    .all<MembershipRow>();
  return rows.results ?? [];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().normalize("NFC");
}

// So khớp "không dấu": "cau long thu ba" vẫn tìm ra "Cầu lông Thứ Ba".
function foldDiacritics(value: string): string {
  return normalizeName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .normalize("NFC");
}

function groupNamesText(memberships: MembershipRow[]): string {
  return memberships.map((m) => `"${m.group_name}"`).join(", ");
}

// --- Danh sách tool dạng MCP (inputSchema) ---

function buildMcpToolList() {
  return buildTools()
    .filter((t) => MCP_TOOL_ALLOWLIST.has(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: {
        ...t.function.parameters,
        properties: { group: GROUP_PARAM, ...t.function.parameters.properties },
      },
    }));
}

// Các hàm reply* trong bot.ts vẫn soi "text" tự nhiên để chốt số tiền/tên (guard chống AI
// bịa số từ ngữ cảnh). MCP không có tin nhắn gốc của người dùng, nên dựng text tổng hợp
// từ chính tham số tool — guard có dữ liệu thật thay vì chuỗi rỗng.
function synthesizeText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key} ${value.join(" ")}`);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        push(childKey, childValue);
      }
      return;
    }
    parts.push(`${key} ${String(value)}`);
  };
  for (const [key, value] of Object.entries(args)) push(key, value);
  return parts.join(", ");
}

// --- Thực thi tools/call ---

async function callTool(
  env: Env,
  userId: string,
  name: string,
  rawArgs: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  const args = asObj(rawArgs);
  const groupQuery = typeof args.group === "string" ? args.group.trim() : "";
  delete args.group;

  const memberships = await loadMemberships(env, userId);
  if (!memberships.length) {
    return { content: [{ type: "text", text: "Tài khoản này chưa là thành viên nhóm nào trên TingTing." }], isError: true };
  }

  let target: MembershipRow | undefined;
  if (groupQuery) {
    const needle = foldDiacritics(groupQuery);
    target =
      memberships.find((m) => foldDiacritics(m.group_name) === needle) ??
      memberships.find((m) => foldDiacritics(m.group_name).includes(needle));
    if (!target) {
      return {
        content: [
          { type: "text", text: `Không tìm thấy nhóm "${groupQuery}". Bạn thuộc các nhóm: ${groupNamesText(memberships)}.` },
        ],
        isError: false,
      };
    }
  } else if (memberships.length === 1) {
    target = memberships[0];
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Bạn thuộc nhiều nhóm (${groupNamesText(memberships)}) — hãy gọi lại tool này kèm tham số "group" là tên nhóm muốn thao tác.`,
        },
      ],
      isError: false,
    };
  }

  const runArgs: RunAgentArgs = {
    groupId: target.group_id,
    groupName: target.group_name,
    text: synthesizeText(args),
    actor: {
      userId,
      name: target.member_name ?? undefined,
      memberId: target.member_id ?? undefined,
    },
  };

  try {
    const text = await executeTool(env, runArgs, name, args, undefined);
    return { content: [{ type: "text", text }], isError: false };
  } catch (err) {
    console.error("[mcp] tool", name, err);
    return {
      content: [{ type: "text", text: "Thao tác gặp sự cố kỹ thuật — thử lại sau hoặc dùng web TingTing." }],
      isError: true,
    };
  }
}

// --- JSON-RPC ---

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const mcp = new Hono<{ Bindings: Env }>();

// Handler dùng chung cho POST /mcp (Bearer header) và POST /mcp/<token> (token trong path).
const jsonRpcHandler = async (c: Context<{ Bindings: Env }>) => {
  const auth = await resolveToken(c.env, c.req.header("Authorization"), c.req.param("token"));
  if (!auth) {
    // WWW-Authenticate trỏ tới protected-resource metadata: connector OAuth (ChatGPT/Claude.ai)
    // dựa vào header này để khởi động luồng OAuth (RFC 9728).
    const origin = new URL(c.req.url).origin;
    c.header("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: JsonRpcRequest;
  try {
    body = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }

  // Notification (không có id, vd notifications/initialized) — chỉ xác nhận đã nhận.
  if (body.id === undefined || body.id === null) return c.body(null, 202);

  switch (body.method) {
    case "initialize": {
      const requested = asObj(body.params).protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return c.json(
        rpcResult(body.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tingting", version: "1.0.0" },
        })
      );
    }

    case "ping":
      return c.json(rpcResult(body.id, {}));

    case "tools/list":
      return c.json(rpcResult(body.id, { tools: buildMcpToolList() }));

    case "tools/call": {
      const params = asObj(body.params);
      const name = typeof params.name === "string" ? params.name : "";
      if (!MCP_TOOL_ALLOWLIST.has(name)) {
        return c.json(
          rpcResult(body.id, {
            content: [{ type: "text", text: `Tool "${name}" không tồn tại hoặc chưa được mở cho MCP.` }],
            isError: true,
          })
        );
      }
      const result = await callTool(c.env, auth.userId, name, params.arguments);
      if (auth.kind === "static") {
        c.executionCtx?.waitUntil?.(touchLastUsed(c.env, auth.tokenHash).catch(() => {}));
      }
      return c.json(rpcResult(body.id, result));
    }

    default:
      return c.json(rpcError(body.id, -32601, `Method not found: ${body.method ?? ""}`));
  }
};

const notAllowed = (c: Context<{ Bindings: Env }>) => c.text("Method Not Allowed", 405);

mcp.post("/", jsonRpcHandler);
mcp.post("/:token", jsonRpcHandler);

// Stateless server: không có kênh SSE cho GET, không có session để xoá.
mcp.get("/", notAllowed);
mcp.get("/:token", notAllowed);
mcp.delete("/", notAllowed);
mcp.delete("/:token", notAllowed);

export default mcp;
