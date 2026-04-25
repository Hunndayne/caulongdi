import { Hono } from "hono";
import { Env } from "../types";

const payments = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

payments.post("/:id/toggle", async (c) => {
  const { id } = c.req.param();
  const row = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first() as any;
  if (!row) return c.json({ error: "Not found" }, 404);
  const newPaid = row.paid === 0 ? 1 : 0;
  const paidAt = newPaid === 1 ? new Date().toISOString() : null;
  await c.env.DB.prepare("UPDATE payments SET paid = ?, paid_at = ? WHERE id = ?")
    .bind(newPaid, paidAt, id)
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
  return c.json(updated);
});

export default payments;
