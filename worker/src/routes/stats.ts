import { Hono } from "hono";
import { Env } from "../types";

const stats = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

type CountRow = { cnt: number };
type MemberStatsRow = {
  member_id: string;
  user_id?: string | null;
  member_name: string;
  avatar_color: string;
  attend_count: number;
  total_owed: number;
  total_paid: number;
};

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id")
  );
}

async function canAccessGroup(c: any, groupId: string) {
  if (c.get("userRole") === "admin") return true;
  const membership = await c.env.DB.prepare(`
    SELECT role
    FROM group_members
    WHERE group_id = ? AND user_id = ?
  `)
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;
  return Boolean(membership);
}

function mapMemberStats(row: MemberStatsRow) {
  return {
    memberId: row.member_id,
    userId: row.user_id ?? undefined,
    memberName: row.member_name,
    avatarColor: row.avatar_color,
    attendCount: row.attend_count,
    totalOwed: row.total_owed,
    totalPaid: row.total_paid,
    debt: row.total_owed - row.total_paid,
  };
}

async function getGroupMemberStats(c: any, groupId: string) {
  const rows = await c.env.DB.prepare(`
    WITH scoped_members AS (
      SELECT m.id, m.user_id, m.name, m.avatar_color
      FROM members m
      WHERE m.is_active = 1
        AND m.group_id = ?
    ),
    attendance AS (
      SELECT sm.member_id, COUNT(DISTINCT sm.session_id) AS attend_count
      FROM session_members sm
      JOIN scoped_members m ON m.id = sm.member_id
      WHERE sm.attended = 1
      GROUP BY sm.member_id
    ),
    payment_totals AS (
      SELECT p.member_id,
        COALESCE(SUM(p.amount_owed), 0) AS total_owed,
        COALESCE(SUM(CASE WHEN p.paid = 1 THEN p.amount_owed ELSE 0 END), 0) AS total_paid
      FROM payments p
      JOIN scoped_members m ON m.id = p.member_id
      GROUP BY p.member_id
    )
    SELECT
      m.id AS member_id,
      m.user_id,
      m.name AS member_name,
      m.avatar_color,
      COALESCE(a.attend_count, 0) AS attend_count,
      COALESCE(pt.total_owed, 0) AS total_owed,
      COALESCE(pt.total_paid, 0) AS total_paid
    FROM scoped_members m
    LEFT JOIN attendance a ON a.member_id = m.id
    LEFT JOIN payment_totals pt ON pt.member_id = m.id
    ORDER BY attend_count DESC, m.name COLLATE NOCASE ASC
  `)
    .bind(groupId)
    .all() as { results: MemberStatsRow[] };

  return rows.results.map(mapMemberStats);
}

async function getAllMemberStats(c: any) {
  const isAdmin = c.get("userRole") === "admin";
  const scopedMembersSql = isAdmin
    ? `
      SELECT m.id, m.user_id, m.name, m.avatar_color
      FROM members m
      WHERE m.is_active = 1
    `
    : `
      SELECT m.id, m.user_id, m.name, m.avatar_color
      FROM members m
      WHERE m.is_active = 1
        AND (
          m.group_id IS NULL
          OR m.group_id IN (
            SELECT gm.group_id
            FROM group_members gm
            WHERE gm.user_id = ?
          )
        )
    `;

  const rows = await c.env.DB.prepare(`
    WITH scoped_members AS (
      ${scopedMembersSql}
    ),
    member_groups AS (
      SELECT
        CASE
          WHEN user_id IS NOT NULL THEN 'user:' || user_id
          ELSE 'member:' || id
        END AS member_id,
        MAX(user_id) AS user_id,
        MAX(name) AS member_name,
        MAX(avatar_color) AS avatar_color
      FROM scoped_members
      GROUP BY
        CASE
          WHEN user_id IS NOT NULL THEN 'user:' || user_id
          ELSE 'member:' || id
        END
    ),
    attendance AS (
      SELECT
        CASE
          WHEN m.user_id IS NOT NULL THEN 'user:' || m.user_id
          ELSE 'member:' || m.id
        END AS member_id,
        COUNT(DISTINCT sm.session_id) AS attend_count
      FROM scoped_members m
      LEFT JOIN session_members sm
        ON sm.member_id = m.id
       AND sm.attended = 1
      GROUP BY
        CASE
          WHEN m.user_id IS NOT NULL THEN 'user:' || m.user_id
          ELSE 'member:' || m.id
        END
    ),
    payment_totals AS (
      SELECT
        CASE
          WHEN m.user_id IS NOT NULL THEN 'user:' || m.user_id
          ELSE 'member:' || m.id
        END AS member_id,
        COALESCE(SUM(p.amount_owed), 0) AS total_owed,
        COALESCE(SUM(CASE WHEN p.paid = 1 THEN p.amount_owed ELSE 0 END), 0) AS total_paid
      FROM scoped_members m
      LEFT JOIN payments p ON p.member_id = m.id
      GROUP BY
        CASE
          WHEN m.user_id IS NOT NULL THEN 'user:' || m.user_id
          ELSE 'member:' || m.id
        END
    )
    SELECT
      mg.member_id,
      mg.user_id,
      mg.member_name,
      mg.avatar_color,
      COALESCE(a.attend_count, 0) AS attend_count,
      COALESCE(pt.total_owed, 0) AS total_owed,
      COALESCE(pt.total_paid, 0) AS total_paid
    FROM member_groups mg
    LEFT JOIN attendance a ON a.member_id = mg.member_id
    LEFT JOIN payment_totals pt ON pt.member_id = mg.member_id
    ORDER BY attend_count DESC, mg.member_name COLLATE NOCASE ASC
  `)
    .bind(...(isAdmin ? [] : [c.get("userId")]))
    .all() as { results: MemberStatsRow[] };

  return rows.results.map(mapMemberStats);
}

stats.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();

  try {
    if (groupId && !(await canAccessGroup(c, groupId))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const totalSessionsRow = groupId
      ? await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE group_id = ?")
        .bind(groupId)
        .first<CountRow>()
      : c.get("userRole") === "admin"
        ? await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM sessions").first<CountRow>()
        : await c.env.DB.prepare(`
          SELECT COUNT(*) as cnt
          FROM sessions s
          WHERE s.group_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM group_members gm
               WHERE gm.group_id = s.group_id
                 AND gm.user_id = ?
             )
        `)
          .bind(c.get("userId"))
          .first<CountRow>();

    const memberStats = groupId
      ? await getGroupMemberStats(c, groupId)
      : await getAllMemberStats(c);

    const monthlyStats = groupId
      ? await c.env.DB.prepare(`
        SELECT
          substr(s.date, 1, 7) as month,
          COUNT(*) as session_count,
          COALESCE(SUM(c.total), 0) as total_cost
        FROM sessions s
        LEFT JOIN (
          SELECT session_id, SUM(amount) as total FROM costs GROUP BY session_id
        ) c ON c.session_id = s.id
        WHERE s.group_id = ?
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12
      `)
        .bind(groupId)
        .all()
      : c.get("userRole") === "admin"
        ? await c.env.DB.prepare(`
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
        `).all()
        : await c.env.DB.prepare(`
          SELECT
            substr(s.date, 1, 7) as month,
            COUNT(*) as session_count,
            COALESCE(SUM(c.total), 0) as total_cost
          FROM sessions s
          LEFT JOIN (
            SELECT session_id, SUM(amount) as total FROM costs GROUP BY session_id
          ) c ON c.session_id = s.id
          WHERE s.group_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM group_members gm
               WHERE gm.group_id = s.group_id
                 AND gm.user_id = ?
             )
          GROUP BY month
          ORDER BY month DESC
          LIMIT 12
        `)
          .bind(c.get("userId"))
          .all();

    return c.json({
      totalSessions: totalSessionsRow?.cnt ?? 0,
      memberStats,
      monthlyStats: monthlyStats.results,
    });
  } catch (error) {
    if (!isMissingGroupSchema(error)) throw error;
  }

  const totalSessionsRow = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM sessions").first<CountRow>();
  const memberStats = await c.env.DB.prepare(`
    WITH scoped_members AS (
      SELECT m.id, m.user_id, m.name, m.avatar_color
      FROM members m
      WHERE m.is_active = 1
    ),
    attendance AS (
      SELECT sm.member_id, COUNT(DISTINCT sm.session_id) AS attend_count
      FROM session_members sm
      JOIN scoped_members m ON m.id = sm.member_id
      WHERE sm.attended = 1
      GROUP BY sm.member_id
    ),
    payment_totals AS (
      SELECT p.member_id,
        COALESCE(SUM(p.amount_owed), 0) AS total_owed,
        COALESCE(SUM(CASE WHEN p.paid = 1 THEN p.amount_owed ELSE 0 END), 0) AS total_paid
      FROM payments p
      JOIN scoped_members m ON m.id = p.member_id
      GROUP BY p.member_id
    )
    SELECT
      m.id AS member_id,
      m.user_id,
      m.name AS member_name,
      m.avatar_color,
      COALESCE(a.attend_count, 0) AS attend_count,
      COALESCE(pt.total_owed, 0) AS total_owed,
      COALESCE(pt.total_paid, 0) AS total_paid
    FROM scoped_members m
    LEFT JOIN attendance a ON a.member_id = m.id
    LEFT JOIN payment_totals pt ON pt.member_id = m.id
    ORDER BY attend_count DESC, m.name COLLATE NOCASE ASC
  `).all<MemberStatsRow>();

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
    memberStats: memberStats.results.map(mapMemberStats),
    monthlyStats: monthlyStats.results,
  });
});

export default stats;
