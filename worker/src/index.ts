import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { isAdminEmail } from "./admin";
import { createAuth } from "./auth";
import { Env } from "./types";
import membersRouter from "./routes/members";
import sessionsRouter from "./routes/sessions";
import paymentsRouter from "./routes/payments";
import statsRouter from "./routes/stats";
import profilesRouter from "./routes/profiles";
import groupsRouter from "./routes/groups";
import paymentWebhooksRouter from "./routes/paymentWebhooks";

const app = new Hono<{ Bindings: Env }>();

type PreviewSession = {
  id: string;
  date: string;
  start_time: string;
  venue: string;
  location?: string | null;
  note?: string | null;
  status: string;
  attendee_count: number;
  attendee_names: string | null;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatPreviewDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

async function getPreviewSession(c: Context<{ Bindings: Env }>, id: string) {
  return c.env.DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
      (SELECT group_concat(m.name, ', ') FROM session_members sm JOIN members m ON sm.member_id = m.id WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_names
    FROM sessions s
    WHERE s.id = ?
  `)
    .bind(id)
    .first<PreviewSession>();
}

function previewTitle(session?: PreviewSession | null) {
  return session ? `Cầu lông tại ${session.venue}` : "Hội cầu lông";
}

function previewDescription(session?: PreviewSession | null) {
  if (!session) return "Xem lịch chơi và tham gia buổi cầu lông của nhóm.";
  const place = session.location ? ` tại ${session.location}` : "";
  const names = session.attendee_names ? ` (${session.attendee_names})` : "";
  const count = session.attendee_count ? ` · ${session.attendee_count} người tham gia${names}` : "";
  return `${formatPreviewDate(session.date)} lúc ${session.start_time}${place}${count}`;
}

function renderPreviewSvg(session: PreviewSession) {
  const dateLine = `${formatPreviewDate(session.date)} · ${session.start_time}`;
  const location = session.location ?? "Hội cầu lông";
  const count = `${session.attendee_count} người tham gia`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ecfdf5"/>
  <rect x="72" y="72" width="1056" height="486" rx="32" fill="#ffffff"/>
  <circle cx="152" cy="150" r="28" fill="#16a34a"/>
  <text x="198" y="161" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#14532d">Hội cầu lông</text>
  <text x="120" y="275" font-family="Arial, sans-serif" font-size="64" font-weight="800" fill="#111827">${escapeHtml(truncate(session.venue, 36))}</text>
  <text x="120" y="360" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="#16a34a">${escapeHtml(dateLine)}</text>
  <text x="120" y="430" font-family="Arial, sans-serif" font-size="32" fill="#4b5563">${escapeHtml(truncate(location, 54))}</text>
  <text x="120" y="495" font-family="Arial, sans-serif" font-size="30" fill="#6b7280">${escapeHtml(count)}</text>
</svg>`;
}

async function renderSessionHtml(c: Context<{ Bindings: Env }>, session: PreviewSession | null) {
  const pageUrl = new URL(c.req.url);
  const imageUrl = session ? `${pageUrl.origin}/sessions/${session.id}/preview.svg` : `${pageUrl.origin}/`;
  const title = previewTitle(session);
  const description = previewDescription(session);
  const indexResponse = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
  let html = await indexResponse.text();

  const tags = `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Hội cầu lông" />
    <meta property="og:url" content="${escapeHtml(pageUrl.href)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  `;

  html = html.replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = html.includes("</head>") ? html.replace("</head>", `${tags}\n</head>`) : `${tags}${html}`;

  const headers = new Headers(indexResponse.headers);
  headers.set("content-type", "text/html;charset=UTF-8");
  headers.delete("content-length");
  return new Response(html, { status: 200, headers });
}

app.use(
  "*",
  cors({
    origin: (origin) => origin,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

app.get("/sessions/:id/preview.svg", async (c) => {
  const session = await getPreviewSession(c, c.req.param("id"));
  if (!session) return c.text("Not found", 404);

  return new Response(renderPreviewSvg(session), {
    headers: {
      "content-type": "image/svg+xml;charset=UTF-8",
      "cache-control": "public, max-age=300",
    },
  });
});

app.get("/sessions/:id", async (c) => {
  const session = await getPreviewSession(c, c.req.param("id"));
  return renderSessionHtml(c, session);
});

app.route("/api/payment-webhooks", paymentWebhooksRouter);

// Auth middleware for protected routes
app.use("/api/*", async (c, next) => {
  // Skip auth routes
  if (c.req.path.startsWith("/api/auth/")) return next();

  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  c.set("userId", session.user.id);

  // Fetch role from DB since better-auth might not include custom fields
  const user = await c.env.DB.prepare("SELECT role, email FROM users WHERE id = ?")
    .bind(session.user.id)
    .first<{ role: string; email: string }>();

  let userRole = user?.role ?? "member";
  if (user && isAdminEmail(user.email) && userRole !== "admin") {
    await c.env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
      .bind(session.user.id)
      .run();
    userRole = "admin";
  }

  c.set("userRole", userRole as any);

  await next();
});

app.route("/api/members", membersRouter);
app.route("/api/sessions", sessionsRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/profiles", profilesRouter);
app.route("/api/groups", groupsRouter);

export default app;
