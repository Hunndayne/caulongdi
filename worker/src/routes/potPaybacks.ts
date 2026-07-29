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
import { canManageGroupPot, computeSessionSettlement } from "./sessions";

const potPaybacks = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type PotPaybackStateRow = {
  member_id: string;
  name: string;
  transferred_at: string | null;
  transferred_by: string | null;
  confirmed_at: string | null;
  marked_amount: number | null;
};

// Trạng thái hai bước đã ghi nhận cho buổi. Giữ cả những dòng mà số cần hoàn giờ đã về 0
// (chi phí bị sửa/xoá sau khi quỹ đã chuyển) để trưởng nhóm còn thấy mà thu lại phần chênh.
const PAYBACK_STATE_QUERY = `
  SELECT
    pb.member_id,
    m.name,
    pb.transferred_at,
    pb.transferred_by,
    pb.confirmed_at,
    pb.amount AS marked_amount
  FROM pot_paybacks pb
  JOIN members m ON m.id = pb.member_id
  WHERE pb.session_id = ?
`;

async function loadSession(c: any, sessionId: string) {
  return c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
}

/**
 * Số tiền cần hoàn = số dư RÒNG của người ứng (đã ứng − phần họ phải chịu), lấy từ đúng lõi
 * chốt sổ mà bảng payments dùng. Không phải tổng chi phí họ ứng: họ đã không nộp phần mình
 * vào hũ nữa, nên hoàn nguyên số đã ứng là trả thừa.
 */
async function listPaybacks(c: any, sessionId: string) {
  const settlement = await computeSessionSettlement(c.env, sessionId);
  const amounts = settlement.settlement?.paybacks ?? new Map<string, number>();

  const stateRows = await c.env.DB.prepare(PAYBACK_STATE_QUERY).bind(sessionId).all();
  const stateByMember = new Map<string, PotPaybackStateRow>(
    ((stateRows.results ?? []) as PotPaybackStateRow[]).map((row) => [row.member_id, row])
  );

  // Người cần hoàn theo tính toán mới + người đã có dòng trạng thái cũ.
  const memberIds = new Set<string>([...amounts.keys(), ...stateByMember.keys()]);
  if (memberIds.size === 0) return [];

  const nameRows = await c.env.DB.prepare(
    `SELECT id, name FROM members WHERE id IN (${[...memberIds].map(() => "?").join(", ")})`
  )
    .bind(...memberIds)
    .all();
  const nameById = new Map<string, string>(
    ((nameRows.results ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name])
  );

  return [...memberIds]
    .map((memberId) => {
      const state = stateByMember.get(memberId) ?? null;
      return {
        memberId,
        name: nameById.get(memberId) ?? state?.name ?? memberId,
        amount: Math.round(amounts.get(memberId) ?? 0),
        transferredAt: state?.transferred_at ?? null,
        transferredBy: state?.transferred_by ?? null,
        confirmedAt: state?.confirmed_at ?? null,
        // Số tiền lúc đánh dấu — lệch với amount hiện tại nghĩa là chi phí đã đổi sau khi chuyển.
        markedAmount: state?.marked_amount === null || state?.marked_amount === undefined
          ? null
          : Math.round(state.marked_amount),
      };
    })
    // Bỏ người vừa không còn phải hoàn, vừa chưa từng được đánh dấu — không có gì để làm.
    .filter((item) => item.amount > 0 || item.transferredAt !== null)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "vi"));
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
  if (!target || target.amount <= 0) {
    return c.json({ error: "Hũ không còn nợ người này khoản nào (đã cấn trừ phần họ phải chịu)" }, 400);
  }

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
