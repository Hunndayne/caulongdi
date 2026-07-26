// Hũ hoàn lại tiền cho người ứng chi phí (buổi thu về tài khoản chung của nhóm).
//
// Đặt ở file riêng thay vì nhét vào payments: bảng payments được cộng dồn ở tổng buổi,
// thống kê và bot, thêm dòng ngược chiều vào đó là sai mọi con số; ngoài ra
// payments.member_id NOT NULL nên hũ không thể là bên nợ.
//
// Hai bước giống nếp payments: người rút quỹ đánh dấu đã chuyển → người ứng xác nhận đã nhận.
// Quyền rút quỹ chỉ thuộc về trưởng nhóm (canManageGroupPot), không phải quyền quản lý buổi.

import { Hono } from "hono";
import { Env } from "../types";
import { ensurePotPaybackTable } from "../db/potPaybackTable";
import { canManageGroupPot } from "./sessions";

const potPaybacks = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type PotPaybackRow = {
  member_id: string;
  name: string;
  user_id: string | null;
  amount: number;
  transferred_at: string | null;
  transferred_by: string | null;
  confirmed_at: string | null;
  marked_amount: number | null;
};

// Số tiền cần hoàn = tổng chi phí người đó đã ứng cho buổi. Tính ở server, không tin client.
// Bỏ chi phí chưa rõ người dùng (consumer_pending) cho khớp lõi chia tiền.
const PAYBACK_QUERY = `
  SELECT
    c.payer_id AS member_id,
    m.name,
    m.user_id,
    SUM(c.amount) AS amount,
    pb.transferred_at,
    pb.transferred_by,
    pb.confirmed_at,
    pb.amount AS marked_amount
  FROM costs c
  JOIN members m ON m.id = c.payer_id
  LEFT JOIN pot_paybacks pb ON pb.session_id = c.session_id AND pb.member_id = c.payer_id
  WHERE c.session_id = ?
    AND c.payer_id IS NOT NULL
    AND COALESCE(c.consumer_pending, 0) != 1
  GROUP BY c.payer_id
  ORDER BY SUM(c.amount) DESC
`;

async function loadSession(c: any, sessionId: string) {
  return c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
}

async function listPaybacks(c: any, sessionId: string) {
  const rows = await c.env.DB.prepare(PAYBACK_QUERY).bind(sessionId).all();

  return ((rows.results ?? []) as PotPaybackRow[]).map((row) => ({
    memberId: row.member_id,
    name: row.name,
    amount: Math.round(row.amount),
    transferredAt: row.transferred_at,
    transferredBy: row.transferred_by,
    confirmedAt: row.confirmed_at,
    // Số tiền lúc đánh dấu — lệch với amount hiện tại nghĩa là chi phí đã đổi sau khi chuyển.
    markedAmount: row.marked_amount === null ? null : Math.round(row.marked_amount),
  }));
}

potPaybacks.get("/:sessionId", async (c) => {
  const { sessionId } = c.req.param();

  const session = await loadSession(c, sessionId);
  if (!session) return c.json({ error: "Not found" }, 404);

  await ensurePotPaybackTable(c.env.DB);
  const items = await listPaybacks(c, sessionId);

  // Trưởng nhóm thấy hết; người ứng tiền chỉ cần thấy dòng của mình để xác nhận đã nhận.
  if (await canManageGroupPot(c, session as any)) return c.json(items);

  const userId = c.get("userId");
  const own = await c.env.DB.prepare(
    "SELECT id FROM members WHERE user_id = ? AND session_id IS NULL"
  )
    .bind(userId)
    .all<{ id: string }>();
  const ownIds = new Set((own.results ?? []).map((row) => row.id));

  return c.json(items.filter((item) => ownIds.has(item.memberId)));
});

// Người rút quỹ đánh dấu đã chuyển lại cho người ứng.
potPaybacks.post("/:sessionId/:memberId/transfer", async (c) => {
  const { sessionId, memberId } = c.req.param();

  const session = await loadSession(c, sessionId);
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageGroupPot(c, session as any))) return c.json({ error: "Forbidden" }, 403);

  await ensurePotPaybackTable(c.env.DB);

  const items = await listPaybacks(c, sessionId);
  const target = items.find((item) => item.memberId === memberId);
  if (!target) return c.json({ error: "Người này không ứng chi phí nào trong buổi" }, 400);

  const now = new Date().toISOString();
  await c.env.DB.prepare(`
    INSERT INTO pot_paybacks (session_id, member_id, amount, transferred_at, transferred_by, confirmed_at)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(session_id, member_id) DO UPDATE SET
      amount = excluded.amount,
      transferred_at = excluded.transferred_at,
      transferred_by = excluded.transferred_by
  `)
    .bind(sessionId, memberId, target.amount, now, c.get("userId"))
    .run();

  return c.json({ success: true, items: await listPaybacks(c, sessionId) });
});

// Người ứng tiền xác nhận đã nhận. Người quản lý buổi cũng xác nhận thay được cho trường hợp
// người ứng không dùng web (vãng lai, chưa liên kết tài khoản).
potPaybacks.post("/:sessionId/:memberId/confirm", async (c) => {
  const { sessionId, memberId } = c.req.param();

  const session = await loadSession(c, sessionId);
  if (!session) return c.json({ error: "Not found" }, 404);

  await ensurePotPaybackTable(c.env.DB);

  const member = await c.env.DB.prepare("SELECT user_id FROM members WHERE id = ?")
    .bind(memberId)
    .first<{ user_id: string | null }>();

  const isOwnMember = Boolean(member?.user_id && member.user_id === c.get("userId"));
  if (!isOwnMember && !(await canManageGroupPot(c, session as any))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const existing = await c.env.DB.prepare(
    "SELECT transferred_at FROM pot_paybacks WHERE session_id = ? AND member_id = ?"
  )
    .bind(sessionId, memberId)
    .first<{ transferred_at: string | null }>();
  if (!existing?.transferred_at) {
    return c.json({ error: "Chưa có ai đánh dấu đã chuyển khoản này" }, 409);
  }

  await c.env.DB.prepare(
    "UPDATE pot_paybacks SET confirmed_at = ? WHERE session_id = ? AND member_id = ?"
  )
    .bind(new Date().toISOString(), sessionId, memberId)
    .run();

  return c.json({ success: true, items: await listPaybacks(c, sessionId) });
});

// Bỏ đánh dấu (bấm nhầm). Xoá luôn hàng để quay về trạng thái chưa hoàn.
potPaybacks.delete("/:sessionId/:memberId", async (c) => {
  const { sessionId, memberId } = c.req.param();

  const session = await loadSession(c, sessionId);
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageGroupPot(c, session as any))) return c.json({ error: "Forbidden" }, 403);

  await ensurePotPaybackTable(c.env.DB);
  await c.env.DB.prepare("DELETE FROM pot_paybacks WHERE session_id = ? AND member_id = ?")
    .bind(sessionId, memberId)
    .run();

  return c.json({ success: true, items: await listPaybacks(c, sessionId) });
});

export default potPaybacks;
