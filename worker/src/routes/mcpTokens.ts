// Quản lý token MCP của người dùng (cookie auth qua middleware /api/*).
// Token = danh tính user, truy cập mọi nhóm user là thành viên; plaintext chỉ hiện 1 lần.

import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";
import { ensureMcpTables } from "../db/mcpTables";
import { vnNow } from "./bot";

const MAX_ACTIVE_TOKENS = 10;

type McpTokenRow = {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `ttmcp_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function toToken(row: McpTokenRow) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const mcpTokens = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

mcpTokens.get("/", async (c) => {
  await ensureMcpTables(c.env.DB);
  const rows = await c.env.DB.prepare(
    "SELECT id, label, created_at, last_used_at, revoked_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(c.get("userId"))
    .all<McpTokenRow>();
  return c.json((rows.results ?? []).map(toToken));
});

mcpTokens.post("/", async (c) => {
  await ensureMcpTables(c.env.DB);
  const userId = c.get("userId");

  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL"
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_TOKENS) {
    return c.json({ error: `Chỉ giữ tối đa ${MAX_ACTIVE_TOKENS} token đang hoạt động — hãy thu hồi bớt trước.` }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const label = typeof (body as { label?: unknown }).label === "string"
    ? (body as { label: string }).label.trim().slice(0, 60)
    : "";
  const token = generateMcpToken();
  const id = nanoid();

  await c.env.DB.prepare(
    "INSERT INTO mcp_tokens (id, user_id, group_id, label, token_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?)"
  )
    .bind(id, userId, label || "App AI", await sha256Hex(token), vnNow().toISOString())
    .run();

  return c.json({ id, token, ...{ label: label || "App AI" } }, 201);
});

mcpTokens.delete("/:id", async (c) => {
  await ensureMcpTables(c.env.DB);
  const { id } = c.req.param();
  const result = await c.env.DB.prepare(
    "UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
  )
    .bind(vnNow().toISOString(), id, c.get("userId"))
    .run();
  if (!result.success) return c.json({ error: "Không thu hồi được token." }, 400);
  return c.json({ ok: true });
});

export default mcpTokens;
