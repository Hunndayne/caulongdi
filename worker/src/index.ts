import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { Env } from "./types";
import membersRouter from "./routes/members";
import sessionsRouter from "./routes/sessions";
import paymentsRouter from "./routes/payments";
import statsRouter from "./routes/stats";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => origin,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.on(["GET", "POST"], "/api/auth/**", (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

// Auth middleware for protected routes
app.use("/api/*", async (c, next) => {
  // Skip auth routes
  if (c.req.path.startsWith("/api/auth/")) return next();

  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  c.set("userId", session.user.id);

  // Fetch role from DB since better-auth might not include custom fields
  const user = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?")
    .bind(session.user.id)
    .first<{ role: string }>();
  c.set("userRole", (user?.role ?? "member") as any);

  await next();
});

app.route("/api/members", membersRouter);
app.route("/api/sessions", sessionsRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/stats", statsRouter);

export default app;
