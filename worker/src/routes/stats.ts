import { Hono } from "hono";
import { Env } from "../types";

const stats = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

stats.get("/", async (c) => {
  const totalSessionsRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM sessions"
  ).first<{ cnt: number }>();

  const memberStats = await c.env.DB.prepare(`
    SELECT
      m.id as member_id,
      m.name as member_name,
      m.avatar_color,
      COUNT(DISTINCT sm.session_id) as attend_count,
      COALESCE(SUM(p.amount_owed), 0) as total_owed,
      COALESCE(SUM(CASE WHEN p.paid = 1 THEN p.amount_owed ELSE 0 END), 0) as total_paid
    FROM members m
    LEFT JOIN session_members sm ON sm.member_id = m.id AND sm.attended = 1
    LEFT JOIN payments p ON p.member_id = m.id
    WHERE m.is_active = 1
    GROUP BY m.id
    ORDER BY attend_count DESC
  `).all();

  const monthlyStats = await c.env.DB.prepare(`
    SELECT
      substr(s.date, 1, 7) as month,
      COUNT(*) as session_count,
      COALESCE(SUM(c.total), 0) as total_cost
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, SUM(amount) as total FROM costs GROUP BY session_id
    ) c ON c.session_id = s.id
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all();

  return c.json({
    totalSessions: totalSessionsRow?.cnt ?? 0,
    memberStats: memberStats.results.map((r: any) => ({
      memberId: r.member_id,
      memberName: r.member_name,
      avatarColor: r.avatar_color,
      attendCount: r.attend_count,
      totalOwed: r.total_owed,
      totalPaid: r.total_paid,
      debt: r.total_owed - r.total_paid,
    })),
    monthlyStats: monthlyStats.results,
  });
});

export default stats;
