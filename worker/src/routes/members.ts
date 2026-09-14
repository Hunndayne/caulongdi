import { Hono } from "hono";
import { Env } from "../types";
import { nanoid } from "../utils";
import { canManageSession, recalcSessionPayments } from "./sessions";

const members = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id")
  );
}

// Vãng lai không có quyền admin toàn hệ thống riêng — quyền sửa/xoá đi theo quyền quản lý buổi sinh ra nó.
async function canManageWalkinSession(c: any, sessionId: unknown) {
  if (c.get("userRole") === "admin") return true;
  if (!sessionId || typeof sessionId !== "string") return false;
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
  if (!session) return false;
  return canManageSession(c, session);
}

members.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
  const memberSelect = `
    SELECT
      m.*,
      u.email AS user_email,
      -- Tên/ảnh thật từ hồ sơ: members.name là bản chụp lúc tạo, chỉ site-admin sửa được.
      u.name AS user_name,
      u.avatar_url AS user_avatar_url,
      u.bank_bin AS user_bank_bin,
      u.bank_account_number AS user_bank_account_number,
      u.bank_account_name AS user_bank_account_name
    FROM members m
    LEFT JOIN users u ON u.id = m.user_id
  `;

  const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

  try {
    if (groupId) {
      const membership = await c.env.DB.prepare(`
        SELECT role
        FROM group_members
        WHERE group_id = ? AND user_id = ?
      `)
        .bind(groupId, c.get("userId"))
        .first<{ role: string }>();

      if (!membership && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const rows = await c.env.DB.prepare(`
        ${memberSelect}
        WHERE m.group_id = ? AND m.is_walkin = 0
        ORDER BY m.is_active DESC, m.name ASC
      `)
        .bind(groupId)
        .all();

      const existingMembers = rows.results as any[];
      const existingUserIds = new Set(existingMembers.map((m: any) => m.user_id).filter(Boolean));

      // Find group members who don't have a members record yet
      const ungrouped = await c.env.DB.prepare(`
        SELECT gm.user_id, u.name, u.email
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ?
          AND gm.user_id NOT IN (
            SELECT user_id FROM members WHERE group_id = ? AND user_id IS NOT NULL
          )
      `).bind(groupId, groupId).all<{ user_id: string; name: string | null; email: string }>();

      const newMembers: any[] = [];
      const now = new Date().toISOString();
      for (const gm of ungrouped.results) {
        if (existingUserIds.has(gm.user_id)) continue;
        const total = [...gm.user_id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const avatarColor = MEMBER_COLORS[total % MEMBER_COLORS.length];
        const memberId = nanoid();
        await c.env.DB.prepare(
          "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)"
        ).bind(memberId, groupId, gm.user_id, gm.name || gm.email, avatarColor, now).run();

        const newMember = await c.env.DB.prepare(`${memberSelect} WHERE m.id = ?`).bind(memberId).first();
        if (newMember) newMembers.push(newMember);
      }

      const allMembers = [...existingMembers, ...newMembers];
      allMembers.sort((a: any, b: any) => {
        if (b.is_active !== a.is_active) return b.is_active - a.is_active;
        return (a.name ?? "").localeCompare(b.name ?? "");
      });

      return c.json(allMembers);
    }

    if (c.get("userRole") === "admin") {
      const rows = await c.env.DB.prepare(`
        ${memberSelect}
        WHERE m.is_walkin = 0
        ORDER BY m.is_active DESC, m.name ASC
      `).all();
      return c.json(rows.results);
    }

    const rows = await c.env.DB.prepare(`
      ${memberSelect}
      WHERE m.is_walkin = 0
        AND (
          m.group_id IS NULL
          OR m.group_id IN (
            SELECT gm.group_id
            FROM group_members gm
            WHERE gm.user_id = ?
          )
        )
      ORDER BY m.is_active DESC, m.name ASC
    `)
      .bind(c.get("userId"))
      .all();
    return c.json(rows.results);
  } catch (error) {
    if (isMissingGroupSchema(error)) {
      const rows = await c.env.DB.prepare(`
        ${memberSelect}
        WHERE m.is_walkin = 0
        ORDER BY m.is_active DESC, m.name ASC
      `).all();
      return c.json(rows.results);
    }
    throw error;
  }
});

members.post("/", async (c) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ name: string; phone?: string; avatarColor?: string; userId?: string; groupId?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = nanoid();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  )
    .bind(id, body.groupId ?? null, body.userId ?? null, body.name.trim(), body.phone ?? null, body.avatarColor ?? "#22c55e", now)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  return c.json(row, 201);
});

members.put("/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ name?: string; phone?: string; avatarColor?: string; isActive?: boolean; refMemberId?: string }>();
  const existing = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<any>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (existing.is_walkin) {
    if (!(await canManageWalkinSession(c, existing.session_id))) return c.json({ error: "Forbidden" }, 403);
  } else if (c.get("userRole") !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Vãng lai là dữ liệu ephemeral của buổi: không cho đổi isActive qua route này
  const nextIsActive = existing.is_walkin
    ? existing.is_active
    : (body.isActive !== undefined ? (body.isActive ? 1 : 0) : existing.is_active);

  // Chỉ vãng lai mới có người ref (người bảo lãnh). Ref phải là thành viên thật, có tài khoản,
  // không phải vãng lai và không phải chính nó — giống lúc thêm vãng lai.
  let nextRefMemberId = existing.ref_member_id ?? null;
  const refChanged = Boolean(existing.is_walkin)
    && body.refMemberId !== undefined
    && (body.refMemberId?.trim() || null) !== (existing.ref_member_id ?? null);
  if (refChanged) {
    const refId = body.refMemberId?.trim();
    if (!refId) return c.json({ error: "Cần chọn người ref (người bảo lãnh)" }, 400);
    if (refId === id) return c.json({ error: "Vãng lai không thể tự làm ref cho chính mình" }, 400);
    const ref = await c.env.DB.prepare("SELECT id, user_id, is_walkin FROM members WHERE id = ?")
      .bind(refId)
      .first<{ id: string; user_id: string | null; is_walkin: number }>();
    if (!ref) return c.json({ error: "Người ref không tồn tại" }, 404);
    if (ref.is_walkin) return c.json({ error: "Người ref không thể là vãng lai" }, 400);
    if (!ref.user_id) return c.json({ error: "Người ref phải có tài khoản trong app" }, 400);
    nextRefMemberId = refId;
  }

  await c.env.DB.prepare(
    "UPDATE members SET name = ?, phone = ?, avatar_color = ?, is_active = ?, ref_member_id = ? WHERE id = ?"
  )
    .bind(
      body.name ?? existing.name,
      body.phone !== undefined ? body.phone : existing.phone,
      body.avatarColor ?? existing.avatar_color,
      nextIsActive,
      nextRefMemberId,
      id
    )
    .run();

  // Đổi ref có thể đổi người gánh nợ (chế độ 'ref') và người xác nhận/QR bên nhận,
  // nên tính lại công nợ chưa xác nhận của buổi.
  if (refChanged && existing.session_id) {
    try {
      await recalcSessionPayments(c.env, existing.session_id);
    } catch (error) {
      console.error("[members:put] recalc after ref change failed", error);
    }
  }

  const row = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  return c.json(row);
});

members.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<any>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (existing.is_walkin) {
    if (!(await canManageWalkinSession(c, existing.session_id))) return c.json({ error: "Forbidden" }, 403);
  } else if (c.get("userRole") !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Thành viên thường (không phải vãng lai) đã từng tham gia buổi/chi phí/công nợ: KHÔNG xoá cứng
  // (sẽ làm mồ côi bản ghi, hỏng lịch sử/thống kê). Thay vào đó chuyển thành vãng lai ẩn — giữ nguyên
  // id nên mọi session_members/costs/payments buổi cũ vẫn trỏ đúng, chỉ biến mất khỏi danh sách thành
  // viên (các query roster đều lọc is_walkin=0). session_id=NULL để không bị dọn rác ephemeral theo buổi.
  if (!existing.is_walkin) {
    const historyRow = await c.env.DB
      .prepare(
        `SELECT 1 FROM session_members WHERE member_id = ?
         UNION ALL SELECT 1 FROM payments WHERE member_id = ? OR recipient_member_id = ?
         UNION ALL SELECT 1 FROM costs WHERE payer_id = ? OR consumer_id = ?
         LIMIT 1`
      )
      .bind(id, id, id, id, id)
      .first();
    if (historyRow) {
      await c.env.DB
        .prepare("UPDATE members SET is_active = 0, is_walkin = 1, session_id = NULL WHERE id = ?")
        .bind(id)
        .run();
      return c.json({ success: true, convertedToWalkin: true });
    }
  }

  // Chưa có lịch sử gì (hoặc vốn là vãng lai): xoá cứng cho sạch.
  // Xoá tường minh theo thứ tự, không phụ thuộc FK cascade (D1 không đảm bảo luôn bật foreign_keys)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM payments WHERE (member_id = ? OR recipient_member_id = ?) AND paid = 0 AND payer_marked_paid = 0"
    ).bind(id, id),
    c.env.DB.prepare("DELETE FROM session_members WHERE member_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id),
  ]);

  if (existing.session_id) {
    const recalcError = await recalcSessionPayments(c.env, existing.session_id);
    if (recalcError) console.warn(`recalcSessionPayments after member delete (session ${existing.session_id}):`, recalcError);
  }

  return c.json({ success: true });
});

export default members;
