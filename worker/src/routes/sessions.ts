import { Hono } from "hono";
import { sendNewSessionNotification, sendPaymentDueNotification } from "../email";
import { Env } from "../types";
import { nanoid } from "../utils";

const sessions = new Hono<{ Bindings: Env; Variables: { userId: string; userRole: string } }>();

const MEMBER_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

type SessionBody = {
  date?: string;
  startTime?: string;
  start_time?: string;
  groupId?: string;
  group_id?: string;
  venue?: string;
  location?: string;
  note?: string;
  status?: string;
  paymentRecipient?: string | null;
  payment_recipient?: string | null;
  allow_all_edit?: number;
  force_payment_recipient?: number;
};

type SessionRow = {
  id: string;
  group_id?: string | null;
  created_by?: string | null;
  status: string;
  [key: string]: unknown;
};

type CostRow = {
  id: string;
  amount: number;
  quantity?: number | null;
  payer_id: string | null;
  consumer_id: string | null;
  consumer_ids?: string | null;
  consumer_pending?: number;
};

type CostBody = {
  label: string;
  amount: number;
  quantity?: number | string | null;
  type?: string;
  payerId?: string | null;
  consumerId?: string | null;
  consumerIds?: string[] | string | null;
  payer_id?: string | null;
  consumer_id?: string | null;
  consumer_ids?: string[] | string | null;
  consumer_pending?: number;
};

type ReceiptCostType = "court" | "water" | "shuttle" | "other";

type ReceiptParsedCost = {
  label: string;
  unitAmount: number;
  quantity: number;
  totalAmount: number;
  type: ReceiptCostType;
  confidence?: number;
};

type ReceiptParseResult = {
  merchantName?: string;
  purchasedAt?: string;
  totalAmount?: number;
  currency: "VND";
  items: ReceiptParsedCost[];
};

type AiUsageStatus = {
  feature: string;
  usageDate: string;
  estimatedNeurons: number;
  requestCount: number;
  dailyBudget: number;
  reservedNeuronsPerScan: number;
  remainingNeurons: number;
  enabled: boolean;
  resetAt: string;
};

type AiUsageReservation = {
  feature: string;
  usageDate: string;
  reservedNeurons: number;
};

type GroupSessionNotificationRow = {
  group_name: string;
  creator_name?: string | null;
  recipient_email?: string | null;
};

type PaymentNotificationRow = {
  debtor_email?: string | null;
  debtor_name: string;
  recipient_name?: string | null;
  amount_owed: number;
};

const RECEIPT_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const RECEIPT_AI_FEATURE = "receipt_scan";
const GEMMA4_INPUT_NEURONS_PER_MILLION_TOKENS = 9091;
const GEMMA4_OUTPUT_NEURONS_PER_MILLION_TOKENS = 27273;
const AI_FREE_DAILY_NEURON_LIMIT = 10_000;
const DEFAULT_AI_DAILY_NEURON_BUDGET = 9_000;
const DEFAULT_RECEIPT_SCAN_RESERVED_NEURONS = 500;
const MAX_RECEIPT_IMAGE_BYTES = 3 * 1024 * 1024;
const RECEIPT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const RECEIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    merchantName: { type: "string" },
    purchasedAt: { type: "string" },
    totalAmount: { type: "integer" },
    currency: { type: "string", enum: ["VND"] },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          unitAmount: { type: "integer" },
          quantity: { type: "integer" },
          totalAmount: { type: "integer" },
          type: { type: "string", enum: ["court", "water", "shuttle", "other"] },
          confidence: { type: "number" },
        },
        required: ["label", "unitAmount", "quantity", "totalAmount", "type", "confidence"],
      },
    },
  },
  required: ["merchantName", "purchasedAt", "totalAmount", "currency", "items"],
};

let aiUsageTableEnsured = false;

function normalizePaymentRecipient(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("auto_") ? value.slice(5) : value;
}

function normalizeQuantity(value: number | string | null | undefined) {
  const quantity = Math.round(Number(value ?? 1));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function normalizeConsumerIds(value: string[] | string | null | undefined, fallback?: string | null) {
  let rawIds: string[] = [];
  if (Array.isArray(value)) {
    rawIds = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        rawIds = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        rawIds = trimmed.split(/[,;\n]+/);
      }
    }
  }

  if (rawIds.length === 0 && fallback) rawIds = [fallback];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of rawIds) {
    const id = String(item ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function encodeConsumerIds(ids: string[]) {
  return ids.length > 0 ? JSON.stringify(ids) : null;
}

function getCostConsumerIds(cost: Pick<CostRow, "consumer_id" | "consumer_ids">) {
  return normalizeConsumerIds(cost.consumer_ids ?? null, cost.consumer_id);
}

function splitAmountEvenly(amount: number, count: number) {
  const roundedAmount = Math.round(amount);
  const baseShare = Math.floor(roundedAmount / count);
  let remainder = roundedAmount - baseShare * count;
  return Array.from({ length: count }, () => {
    const share = baseShare + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return share;
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    let chunk = "";
    const end = Math.min(index + chunkSize, bytes.length);
    for (let cursor = index; cursor < end; cursor += 1) {
      chunk += String.fromCharCode(bytes[cursor]);
    }
    binary += chunk;
  }

  return btoa(binary);
}

function normalizeReceiptAmount(value: unknown) {
  if (typeof value === "number") {
    const rounded = Math.round(value);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
  }

  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return 0;
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeReceiptQuantity(value: unknown) {
  const quantity = Math.round(Number(String(value ?? "1").replace(/[^\d.]/g, "")));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function normalizeReceiptCostType(value: unknown, label: string): ReceiptCostType {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "court" || raw === "water" || raw === "shuttle" || raw === "other") return raw;

  const normalizedLabel = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (/(san|court|gio|phi san|dia diem)/.test(normalizedLabel)) return "court";
  if (/(nuoc|water|sting|revive|tra|cafe|bia|drink)/.test(normalizedLabel)) return "water";
  if (/(cau|shuttle|long vu|vot|ong cau|dung cu)/.test(normalizedLabel)) return "shuttle";
  return "other";
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJsonObjectText(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Try the first object below.
      }
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    throw new Error("AI response is not valid JSON");
  }
}

function getAiResponsePayload(value: unknown): unknown {
  const record = getRecord(value);
  if (!record) return value;

  if (record.response !== undefined) return record.response;
  if (record.result !== undefined) return getAiResponsePayload(record.result);

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = getRecord(choices[0]);
  const message = getRecord(firstChoice?.message);
  const content = message?.content ?? firstChoice?.text;

  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      const itemRecord = getRecord(item);
      return typeof itemRecord?.text === "string" ? itemRecord.text : "";
    }).join("");
  }

  return content ?? value;
}

function getNestedRecord(record: Record<string, unknown>, names: string[]) {
  let current: Record<string, unknown> | null = record;
  for (const name of names) {
    current = getRecord(current?.[name]);
    if (!current) return null;
  }
  return current;
}

function getFirstArray(record: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    const parent = path.length > 1 ? getNestedRecord(record, path.slice(0, -1)) : record;
    if (!parent) continue;
    const value = parent[path[path.length - 1]];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function sanitizeReceiptParseResult(value: unknown): ReceiptParseResult {
  const payload = typeof value === "string" ? parseJsonObjectText(value) : value;
  const record = getRecord(payload);
  if (!record) throw new Error("AI response is not an object");

  const merchantName = String(record.merchantName ?? record.merchant_name ?? record.storeName ?? record.store_name ?? record.vendor ?? "").trim();
  const purchasedAt = String(record.purchasedAt ?? record.purchased_at ?? record.date ?? record.purchaseDate ?? record.purchase_date ?? "").trim();
  const rawTotalAmount = normalizeReceiptAmount(
    record.totalAmount
      ?? record.total_amount
      ?? record.grandTotal
      ?? record.grand_total
      ?? record.total
      ?? record.amountDue
      ?? record.amount_due
  );
  const rawItems = getFirstArray(record, [
    ["items"],
    ["lineItems"],
    ["line_items"],
    ["receiptItems"],
    ["receipt_items"],
    ["products"],
    ["productItems"],
    ["entries"],
    ["costs"],
    ["data", "items"],
    ["data", "lineItems"],
    ["receipt", "items"],
    ["receipt", "lineItems"],
    ["result", "items"],
  ]);
  let items = rawItems
    .map((item): ReceiptParsedCost | null => {
      const itemRecord = getRecord(item);
      if (!itemRecord) return null;

      const label = String(
        itemRecord.label
          ?? itemRecord.name
          ?? itemRecord.productName
          ?? itemRecord.product_name
          ?? itemRecord.product
          ?? itemRecord.item
          ?? itemRecord.description
          ?? itemRecord.text
          ?? ""
      ).trim();
      if (!label) return null;

      const quantity = normalizeReceiptQuantity(itemRecord.quantity ?? itemRecord.qty ?? itemRecord.count ?? itemRecord.so_luong);
      let totalAmount = normalizeReceiptAmount(
        itemRecord.totalAmount
          ?? itemRecord.total_amount
          ?? itemRecord.lineTotal
          ?? itemRecord.line_total
          ?? itemRecord.totalPrice
          ?? itemRecord.total_price
          ?? itemRecord.amount
          ?? itemRecord.total
          ?? itemRecord.value
      );
      let unitAmount = normalizeReceiptAmount(
        itemRecord.unitAmount
          ?? itemRecord.unit_amount
          ?? itemRecord.unitPrice
          ?? itemRecord.unit_price
          ?? itemRecord.price
          ?? itemRecord.rate
      );

      if (!totalAmount && unitAmount) totalAmount = unitAmount * quantity;
      if (!unitAmount && totalAmount) unitAmount = Math.max(1, Math.round(totalAmount / quantity));
      if (!totalAmount || !unitAmount) return null;

      const confidenceRaw = Number(itemRecord.confidence ?? 0.7);
      const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.7;

      return {
        label: label.slice(0, 120),
        unitAmount,
        quantity,
        totalAmount,
        type: normalizeReceiptCostType(itemRecord.type, label),
        confidence,
      };
    })
    .filter((item): item is ReceiptParsedCost => Boolean(item))
    .slice(0, 50);

  if (items.length === 0 && rawTotalAmount > 0) {
    items = [{
      label: "Tổng hóa đơn",
      unitAmount: rawTotalAmount,
      quantity: 1,
      totalAmount: rawTotalAmount,
      type: "other",
      confidence: 0.45,
    }];
  }

  if (items.length === 0) throw new Error("AI did not return any receipt item or total amount");

  const totalAmount = rawTotalAmount || items.reduce((sum, item) => sum + item.totalAmount, 0);

  return {
    merchantName: merchantName || undefined,
    purchasedAt: purchasedAt || undefined,
    totalAmount,
    currency: "VND",
    items,
  };
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDailyAiNeuronBudget(c: any) {
  const configured = readPositiveInteger(c.env.AI_DAILY_NEURON_BUDGET, DEFAULT_AI_DAILY_NEURON_BUDGET);
  return Math.min(configured, AI_FREE_DAILY_NEURON_LIMIT);
}

function getReceiptScanReservedNeurons(c: any) {
  return readPositiveInteger(c.env.AI_RECEIPT_SCAN_RESERVED_NEURONS, DEFAULT_RECEIPT_SCAN_RESERVED_NEURONS);
}

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getNextUtcReset(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

async function ensureAiUsageTable(c: any) {
  if (aiUsageTableEnsured) return;

  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS ai_usage_daily (
      usage_date TEXT NOT NULL,
      feature TEXT NOT NULL,
      estimated_neurons INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (usage_date, feature)
    )
  `).run();
  await c.env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_date ON ai_usage_daily(usage_date)").run();

  aiUsageTableEnsured = true;
}

async function getAiUsageStatus(c: any, feature = RECEIPT_AI_FEATURE): Promise<AiUsageStatus> {
  await ensureAiUsageTable(c);

  const usageDate = getUtcDayKey();
  const row = await c.env.DB.prepare(`
    SELECT estimated_neurons, request_count
    FROM ai_usage_daily
    WHERE usage_date = ? AND feature = ?
  `)
    .bind(usageDate, feature)
    .first() as { estimated_neurons: number; request_count: number } | null;

  const dailyBudget = getDailyAiNeuronBudget(c);
  const reservedNeuronsPerScan = getReceiptScanReservedNeurons(c);
  const estimatedNeurons = Math.max(0, Math.round(Number(row?.estimated_neurons ?? 0)));
  const requestCount = Math.max(0, Math.round(Number(row?.request_count ?? 0)));
  const remainingNeurons = Math.max(0, dailyBudget - estimatedNeurons);

  return {
    feature,
    usageDate,
    estimatedNeurons,
    requestCount,
    dailyBudget,
    reservedNeuronsPerScan,
    remainingNeurons,
    enabled: remainingNeurons >= reservedNeuronsPerScan,
    resetAt: getNextUtcReset(),
  };
}

async function reserveAiNeurons(c: any, feature = RECEIPT_AI_FEATURE): Promise<{ ok: true; reservation: AiUsageReservation } | { ok: false; status: AiUsageStatus }> {
  await ensureAiUsageTable(c);

  const now = new Date().toISOString();
  const usageDate = getUtcDayKey();
  const dailyBudget = getDailyAiNeuronBudget(c);
  const reservedNeurons = getReceiptScanReservedNeurons(c);

  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO ai_usage_daily (usage_date, feature, estimated_neurons, request_count, updated_at)
    VALUES (?, ?, 0, 0, ?)
  `)
    .bind(usageDate, feature, now)
    .run();

  const result = await c.env.DB.prepare(`
    UPDATE ai_usage_daily
    SET estimated_neurons = estimated_neurons + ?,
        request_count = request_count + 1,
        updated_at = ?
    WHERE usage_date = ?
      AND feature = ?
      AND estimated_neurons + ? <= ?
  `)
    .bind(reservedNeurons, now, usageDate, feature, reservedNeurons, dailyBudget)
    .run();

  if (!result.meta?.changes) {
    return { ok: false, status: await getAiUsageStatus(c, feature) };
  }

  return { ok: true, reservation: { feature, usageDate, reservedNeurons } };
}

async function adjustAiNeuronReservation(c: any, reservation: AiUsageReservation, estimatedNeurons: number) {
  const delta = Math.round(estimatedNeurons) - reservation.reservedNeurons;
  if (delta === 0) return;

  await c.env.DB.prepare(`
    UPDATE ai_usage_daily
    SET estimated_neurons = MAX(0, estimated_neurons + ?),
        updated_at = ?
    WHERE usage_date = ? AND feature = ?
  `)
    .bind(delta, new Date().toISOString(), reservation.usageDate, reservation.feature)
    .run();
}

function findAiUsageRecord(value: unknown): Record<string, unknown> | null {
  const record = getRecord(value);
  if (!record) return null;

  const usage = getRecord(record.usage);
  if (usage) return usage;

  const resultUsage = findAiUsageRecord(record.result);
  if (resultUsage) return resultUsage;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    const choiceUsage = findAiUsageRecord(choice);
    if (choiceUsage) return choiceUsage;
  }

  return null;
}

function readUsageTokenCount(usage: Record<string, unknown> | null, names: string[]) {
  if (!usage) return 0;
  for (const name of names) {
    const count = Number(usage[name]);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

function estimateAiNeuronsFromResult(aiResult: unknown, fallbackNeurons: number) {
  const usage = findAiUsageRecord(aiResult);
  const inputTokens = readUsageTokenCount(usage, ["prompt_tokens", "input_tokens"]);
  const outputTokens = readUsageTokenCount(usage, ["completion_tokens", "output_tokens"]);

  if (!inputTokens && !outputTokens) return fallbackNeurons;

  return Math.max(1, Math.ceil(
    (inputTokens * GEMMA4_INPUT_NEURONS_PER_MILLION_TOKENS
      + outputTokens * GEMMA4_OUTPUT_NEURONS_PER_MILLION_TOKENS) / 1_000_000
  ));
}

function queueTask(c: any, task: Promise<unknown>, label: string) {
  const wrappedTask = task.catch((error) => {
    console.error(`[mail:${label}]`, error);
  });
  c.executionCtx?.waitUntil?.(wrappedTask);
}

function colorForUser(userId: string) {
  const total = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return MEMBER_COLORS[total % MEMBER_COLORS.length];
}

function isMissingGroupSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table: groups") ||
    message.includes("no such table: group_members") ||
    message.includes("no such column: group_id") ||
    message.includes("no such column: created_by")
  );
}

async function isGroupMember(c: any, groupId: string) {
  const row = await c.env.DB.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;
  return Boolean(row);
}

async function isGroupAdmin(c: any, groupId?: string | null) {
  if (!groupId) return false;
  const row = await c.env.DB.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
    .bind(groupId, c.get("userId"))
    .first() as { role: string } | null;
  return row?.role === "admin";
}

async function canOverrideAttendanceLock(c: any, session: Pick<SessionRow, "group_id">) {
  if (c.get("userRole") === "admin") return true;
  return isGroupAdmin(c, session.group_id);
}

async function sessionHasCalculatedPayments(c: any, sessionId: string) {
  const row = await c.env.DB.prepare(`
    SELECT id
    FROM payments
    WHERE session_id = ?
    LIMIT 1
  `)
    .bind(sessionId)
    .first() as { id: string } | null;

  return Boolean(row);
}

async function canAccessSession(c: any, session: SessionRow) {
  if (!session.group_id) return true;
  if (c.get("userRole") === "admin") return true;
  return isGroupMember(c, session.group_id);
}

async function canManageSession(c: any, session: SessionRow) {
  if (c.get("userRole") === "admin") return true;

  const userId = c.get("userId");
  if (session.created_by && session.created_by === userId) {
    if (!session.group_id) return true;
    return isGroupMember(c, session.group_id);
  }

  const managersRaw = (session as any).managers;
  if (managersRaw) {
    try {
      const managers: string[] = JSON.parse(managersRaw);
      if (managers.includes(userId)) return true;
    } catch {
      // ignore bad legacy data
    }
  }

  if ((session as any).allow_all_edit) {
    if (!session.group_id) return true;
    return isGroupMember(c, session.group_id);
  }

  return isGroupAdmin(c, session.group_id);
}

// Không tính allow_all_edit — chỉ creator, managers, admin mới được làm các thao tác nhạy cảm (tính tiền, gửi mail, xóa)
async function canManageSessionStrict(c: any, session: SessionRow) {
  if (c.get("userRole") === "admin") return true;

  const userId = c.get("userId");
  if (session.created_by && session.created_by === userId) {
    if (!session.group_id) return true;
    return isGroupMember(c, session.group_id);
  }

  const managersRaw = (session as any).managers;
  if (managersRaw) {
    try {
      const managers: string[] = JSON.parse(managersRaw);
      if (managers.includes(userId)) return true;
    } catch {
      // ignore bad legacy data
    }
  }

  return isGroupAdmin(c, session.group_id);
}

async function blockIfSessionHasConfirmedPayments(c: any, sessionId: string) {
  const confirmed = await c.env.DB.prepare(`
    SELECT id
    FROM payments
    WHERE session_id = ?
      AND (paid = 1 OR payer_marked_paid = 1)
    LIMIT 1
  `)
    .bind(sessionId)
    .first() as { id: string } | null;

  if (!confirmed) return null;

  return c.json({
    error: "This session has confirmed payments and money-related records are locked",
  }, 409);
}

sessions.get("/", async (c) => {
  const groupId = c.req.query("groupId")?.trim();
  const joinedOnly = c.req.query("joined") === "true";

  if (joinedOnly) {
    try {
      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm2 WHERE sm2.session_id = s.id AND sm2.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        JOIN session_members sm ON sm.session_id = s.id
        JOIN members m ON m.id = sm.member_id
        WHERE m.user_id = ?
          AND sm.attended = 1
          ${groupId ? "AND s.group_id = ?" : ""}
        ORDER BY s.date DESC, s.start_time DESC
      `)
        .bind(...(groupId ? [c.get("userId"), groupId] : [c.get("userId")]))
        .all();
      return c.json(rows.results);
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;
      return c.json([]);
    }
  }

  if (groupId) {
    try {
      if (!(await isGroupMember(c, groupId)) && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        WHERE s.group_id = ?
        ORDER BY s.date DESC, s.start_time DESC
      `)
        .bind(groupId)
        .all();
      return c.json(rows.results);
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;
    }
  }

  try {
    if (c.get("userRole") === "admin") {
      const rows = await c.env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
          (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
        FROM sessions s
        ORDER BY s.date DESC, s.start_time DESC
      `).all();
      return c.json(rows.results);
    }

    const rows = await c.env.DB.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
        (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
      FROM sessions s
      WHERE s.group_id IS NULL
         OR EXISTS (
           SELECT 1
           FROM group_members gm
           WHERE gm.group_id = s.group_id
             AND gm.user_id = ?
         )
      ORDER BY s.date DESC, s.start_time DESC
    `)
      .bind(c.get("userId"))
      .all();
    return c.json(rows.results);
  } catch (error) {
    if (!isMissingGroupSchema(error)) throw error;
  }

  const rows = await c.env.DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.attended = 1) as attendee_count,
      (SELECT COALESCE(SUM(amount), 0) FROM costs co WHERE co.session_id = s.id) as total_cost
    FROM sessions s
    ORDER BY s.date DESC, s.start_time DESC
  `).all();
  return c.json(rows.results);
});

sessions.post("/", async (c) => {
  const body = await c.req.json<SessionBody>();
  const startTime = body.startTime ?? body.start_time;
  const groupId = body.groupId ?? body.group_id;
  const venue = body.venue?.trim();

  if (!body.date || !startTime || !venue) {
    return c.json({ error: "date, startTime, venue required" }, 400);
  }

  const id = nanoid();
  const now = new Date().toISOString();
  let notifyGroupId: string | null = null;

  if (groupId) {
    try {
      if (!(await isGroupMember(c, groupId)) && c.get("userRole") !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }

      await c.env.DB.prepare(`
        INSERT INTO sessions (id, group_id, created_by, date, start_time, venue, location, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?)
      `)
        .bind(id, groupId, c.get("userId"), body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
      notifyGroupId = groupId;
    } catch (error) {
      if (!isMissingGroupSchema(error)) throw error;

      await c.env.DB.prepare(`
        INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)
      `)
        .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
        .run();
    }
  } else {
    await c.env.DB.prepare(`
      INSERT INTO sessions (id, date, start_time, venue, location, note, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?)
    `)
      .bind(id, body.date, startTime, venue, body.location ?? null, body.note ?? null, now)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();

  if (notifyGroupId) {
    const notificationRows = await c.env.DB.prepare(`
      SELECT
        g.name AS group_name,
        creator.name AS creator_name,
        recipient.email AS recipient_email
      FROM groups g
      LEFT JOIN users creator ON creator.id = ?
      JOIN group_members gm ON gm.group_id = g.id
      JOIN users recipient ON recipient.id = gm.user_id
      WHERE g.id = ?
        AND recipient.id <> ?
    `)
      .bind(c.get("userId"), notifyGroupId, c.get("userId"))
      .all<GroupSessionNotificationRow>();

    const recipients = notificationRows.results
      .map((item) => item.recipient_email?.trim())
      .filter((value): value is string => Boolean(value));

    if (recipients.length > 0) {
      const groupName = notificationRows.results[0]?.group_name ?? "Nhóm TingTing";
      const creatorName = notificationRows.results[0]?.creator_name?.trim() || "Một thành viên";
      queueTask(c, sendNewSessionNotification(c.env, {
        groupName,
        creatorName,
        venue,
        date: body.date,
        startTime,
        location: body.location ?? null,
        note: body.note ?? null,
        sessionId: id,
        recipients,
      }), "new-session");
    }
  }

  return c.json(row, 201);
});

sessions.get("/:id", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canAccessSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const members = await c.env.DB.prepare(`
    SELECT m.*, sm.attended,
      u.email AS user_email,
      u.bank_bin AS user_bank_bin,
      u.bank_account_number AS user_bank_account_number,
      u.bank_account_name AS user_bank_account_name
    FROM members m
    JOIN session_members sm ON sm.member_id = m.id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE sm.session_id = ?
  `)
    .bind(id)
    .all();

  const costs = await c.env.DB.prepare(
    "SELECT * FROM costs WHERE session_id = ? ORDER BY rowid ASC"
  ).bind(id).all();

  const payments = await c.env.DB.prepare(
    "SELECT * FROM payments WHERE session_id = ?"
  ).bind(id).all();

  return c.json({ ...session, members: members.results, costs: costs.results, payments: payments.results });
});

sessions.put("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, existing))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<SessionBody>();
  const startTime = body.startTime ?? body.start_time;
  const paymentRecipient = body.paymentRecipient ?? body.payment_recipient;
  const normalizedPaymentRecipient = paymentRecipient === undefined
    ? undefined
    : normalizePaymentRecipient(paymentRecipient);
  const paymentRecipientChanged = normalizedPaymentRecipient !== undefined
    && normalizedPaymentRecipient !== normalizePaymentRecipient((existing as any).payment_recipient ?? null);

  if (paymentRecipientChanged) {
    const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
    if (lockedResponse) return lockedResponse;
  }

  await c.env.DB.prepare(`
    UPDATE sessions
    SET date = ?, start_time = ?, venue = ?, location = ?, note = ?, status = ?, payment_recipient = ?, allow_all_edit = ?, force_payment_recipient = ?
    WHERE id = ?
  `)
    .bind(
      body.date ?? existing.date,
      startTime ?? existing.start_time,
      body.venue?.trim() || existing.venue,
      body.location !== undefined ? body.location : existing.location,
      body.note !== undefined ? body.note : existing.note,
      body.status ?? existing.status,
      paymentRecipient !== undefined ? paymentRecipient || null : (existing as any).payment_recipient ?? null,
      body.allow_all_edit !== undefined ? body.allow_all_edit : ((existing as any).allow_all_edit ?? 0),
      body.force_payment_recipient !== undefined ? body.force_payment_recipient : ((existing as any).force_payment_recipient ?? 0),
      id
    )
    .run();

  if (paymentRecipientChanged) {
    await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id).run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSessionStrict(c, existing))) return c.json({ error: "Forbidden" }, 403);
  const lockedResponse = await blockIfSessionHasConfirmedPayments(c, id);
  if (lockedResponse) return lockedResponse;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

sessions.post("/:id/transfer", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSessionStrict(c, session))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ memberId: string }>();
  if (!body.memberId) return c.json({ error: "memberId required" }, 400);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(body.memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member) return c.json({ error: "Member not found" }, 404);
  if (!member.user_id) return c.json({ error: "Member is not linked to a user account" }, 400);

  await c.env.DB.prepare("UPDATE sessions SET created_by = ? WHERE id = ?")
    .bind(member.user_id, id)
    .run();

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.post("/:id/managers", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSessionStrict(c, session))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ memberId: string }>();
  if (!body.memberId) return c.json({ error: "memberId required" }, 400);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(body.memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member) return c.json({ error: "Member not found" }, 404);
  if (!member.user_id) return c.json({ error: "Member is not linked to a user account" }, 400);

  const managers: string[] = session.managers ? JSON.parse(session.managers as string) : [];
  if (!managers.includes(member.user_id)) {
    managers.push(member.user_id);
    await c.env.DB.prepare("UPDATE sessions SET managers = ? WHERE id = ?")
      .bind(JSON.stringify(managers), id)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return c.json(row);
});

sessions.delete("/:id/managers/:memberId", async (c) => {
  const { id, memberId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSessionStrict(c, session))) return c.json({ error: "Forbidden" }, 403);

  const member = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?")
    .bind(memberId)
    .first<{ id: string; user_id?: string | null }>();
  if (!member || !member.user_id) return c.json({ error: "Member invalid" }, 400);

  const managers: string[] = session.managers ? JSON.parse(session.managers as string) : [];
  const nextManagers = managers.filter((userId) => userId !== member.user_id);
  await c.env.DB.prepare("UPDATE sessions SET managers = ? WHERE id = ?")
    .bind(JSON.stringify(nextManagers), id)
    .run();

  return c.json({ success: true });
});

sessions.post("/:id/join", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(id)
    .first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (session.status !== "upcoming") return c.json({ error: "Session is not open for joining" }, 400);
  if (!(await canAccessSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; name: string; email: string }>();
  if (!user) return c.json({ error: "User not found" }, 404);

  let existingMember: { id: string; group_id?: string | null } | null = null;
  if (session.group_id) {
    existingMember = await c.env.DB.prepare(`
      SELECT id, group_id
      FROM members
      WHERE user_id = ?
        AND (group_id = ? OR group_id IS NULL)
      ORDER BY CASE WHEN group_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `)
      .bind(userId, session.group_id, session.group_id)
      .first<{ id: string; group_id?: string | null }>();
  } else {
    existingMember = await c.env.DB.prepare(`
      SELECT id, group_id
      FROM members
      WHERE user_id = ?
        AND group_id IS NULL
      LIMIT 1
    `)
      .bind(userId)
      .first<{ id: string; group_id?: string | null }>();
  }

  const memberId = existingMember?.id ?? nanoid();
  if (existingMember) {
  await c.env.DB.prepare(`
    UPDATE members
    SET name = ?, phone = ?, is_active = 1, group_id = COALESCE(group_id, ?)
    WHERE id = ?
  `)
      .bind(user.name || user.email, null, session.group_id ?? null, memberId)
      .run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO members (id, group_id, user_id, name, phone, avatar_color, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `)
      .bind(memberId, session.group_id ?? null, userId, user.name || user.email, null, colorForUser(userId), new Date().toISOString())
      .run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
      .bind(id, memberId),
    c.env.DB.prepare("UPDATE session_members SET attended = 1 WHERE session_id = ? AND member_id = ?")
      .bind(id, memberId),
  ]);
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  return c.json({ success: true, memberId });
});

sessions.delete("/:id/join", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT status, group_id FROM sessions WHERE id = ?")
    .bind(id)
    .first<{ status: string; group_id?: string | null }>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (session.status !== "upcoming") return c.json({ error: "Session is not open for changes" }, 400);
  if (session.group_id && !(await canAccessSession(c, { ...session, id, status: session.status } as SessionRow))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (await sessionHasCalculatedPayments(c, id) && !(await canOverrideAttendanceLock(c, session as SessionRow))) {
    return c.json({ error: "Đã tính tiền, chỉ admin mới được bỏ điểm danh buổi này" }, 409);
  }

  const member = await c.env.DB.prepare(`
    SELECT m.id
    FROM members m
    WHERE m.user_id = ?
      AND (
        (? IS NULL AND m.group_id IS NULL)
        OR m.group_id = ?
      )
    ORDER BY CASE WHEN m.group_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `)
    .bind(c.get("userId"), session.group_id ?? null, session.group_id ?? null, session.group_id ?? null)
    .first<{ id: string }>()
    || await c.env.DB.prepare(`
      SELECT m.id
      FROM session_members sm
      JOIN members m ON m.id = sm.member_id
      WHERE sm.session_id = ?
        AND m.user_id = ?
      LIMIT 1
    `)
      .bind(id, c.get("userId"))
      .first<{ id: string }>();

  if (!member) return c.json({ success: true });

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM session_members WHERE session_id = ? AND member_id = ?")
      .bind(id, member.id),
  ]);
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  return c.json({ success: true });
});

sessions.post("/:id/members", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ memberIds: string[] }>();
  const nextMemberIds = Array.isArray(body.memberIds) ? body.memberIds : [];

  if (await sessionHasCalculatedPayments(c, id) && !(await canOverrideAttendanceLock(c, session))) {
    const currentMembers = await c.env.DB.prepare(`
      SELECT member_id
      FROM session_members
      WHERE session_id = ?
    `)
      .bind(id)
      .all<{ member_id: string }>();
    const nextMemberIdSet = new Set(nextMemberIds);
    const removesMember = currentMembers.results.some((member) => !nextMemberIdSet.has(member.member_id));
    if (removesMember) {
      return c.json({ error: "Đã tính tiền, chỉ admin mới được bỏ điểm danh buổi này" }, 409);
    }
  }

  await c.env.DB.prepare("DELETE FROM session_members WHERE session_id = ?").bind(id).run();

  if (nextMemberIds.length) {
    const stmts = nextMemberIds.map((memberId) =>
      c.env.DB.prepare("INSERT INTO session_members (session_id, member_id, attended) VALUES (?, ?, 1)")
        .bind(id, memberId)
    );
    await c.env.DB.batch(stmts);
  }
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  return c.json({ success: true });
});

sessions.get("/:id/receipt/usage", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  return c.json(await getAiUsageStatus(c));
});

sessions.post("/:id/receipt/parse", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  if (!c.env.AI) return c.json({ error: "Workers AI is not configured" }, 503);

  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Cần tải lên ảnh hóa đơn" }, 400);
  }

  const contentType = file.type || "application/octet-stream";
  if (!RECEIPT_IMAGE_TYPES.has(contentType)) {
    return c.json({ error: "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP" }, 400);
  }

  if (file.size <= 0 || file.size > MAX_RECEIPT_IMAGE_BYTES) {
    return c.json({ error: "Ảnh hóa đơn cần nhỏ hơn 3MB" }, 400);
  }

  const imageBase64 = arrayBufferToBase64(await file.arrayBuffer());
  const imageUrl = `data:${contentType};base64,${imageBase64}`;
  console.log("[receipt-ai] image", {
    name: file.name,
    contentType,
    bytes: file.size,
    base64Length: imageBase64.length,
  });
  const prompt = [
    "Đọc ảnh hóa đơn giấy tiếng Việt và trích xuất các dòng chi phí để nhập vào app chia tiền cầu lông.",
    "Trả về JSON đúng schema, không giải thích thêm.",
    "Đơn vị tiền là VND. Bỏ dấu chấm/phẩy phân tách nghìn, không tự thêm số 0 nếu không chắc.",
    "Hóa đơn có thể là phiếu siêu thị dài với cột Description và các dòng số lượng/đơn vị ở ngay bên dưới tên món.",
    "Chỉ lấy các dòng hàng hóa/dịch vụ trong phần Description; bỏ qua VAT, thuế, thanh toán, điểm còn lại, QR, mã vạch và lời cảm ơn.",
    "Tổng hóa đơn thường nằm ở dòng TONG CONG/Tổng cộng.",
    "Mỗi item cần label ngắn, quantity, unitAmount, totalAmount và type.",
    "Label PHẢI là tiếng Việt có dấu, viết thường (trừ tên riêng/thương hiệu). Hóa đơn gốc thường VIẾT HOA KHÔNG DẤU và bị viết tắt do hạn chế ký tự máy in — bạn cần phục hồi lại.",
    "Quy tắc phục hồi label:",
    "- Thêm dấu thanh/dấu mũ đúng tiếng Việt (vd: BANH MANDU THIT → bánh mandu thịt, KHOAI LANG GIANG NHUA → khoai lang giấy nhựa, DUONG MIA → đường mía, MI TRUNG THUANG HANG → mì trứng thượng hạng).",
    "- Mở rộng viết tắt phổ biến khi chắc chắn: SCU=sữa chua, TT=thịt, B.=bánh, CJ=CJ (thương hiệu giữ nguyên), VISSAN=Vissan, GO=Go!, TC=tiệt trùng, T.C=tiệt trùng, NZ=New Zealand, KG=kg, G=g, ML=ml.",
    "- Không bịa thông tin không thấy trên hóa đơn. Nếu không chắc một từ viết tắt nghĩa gì thì giữ nguyên dạng gốc cho từ đó (vd: 'BAO LAC' không rõ → giữ 'bao lac').",
    "- Bỏ mã hàng (vd: '40G', '30G*10') ra khỏi label trừ khi đó là quy cách thực sự cần thiết để phân biệt.",
    "- Tên thương hiệu/sản phẩm có sẵn dấu (Vissan, Ponnie, Probi) giữ nguyên cách viết chuẩn của thương hiệu.",
    "type: court cho phí sân/giờ chơi; water cho nước/đồ uống; shuttle cho cầu lông/dụng cụ; other cho mục còn lại.",
    "Nếu chỉ đọc được tổng hóa đơn mà không thấy dòng hàng, tạo một item label 'Tổng hóa đơn' type other.",
  ].join("\n");

  const aiReservation = await reserveAiNeurons(c);
  if (!aiReservation.ok) {
    return c.json({
      error: "Tính năng quét hóa đơn AI đã tạm tắt vì gần hết hạn mức neuron miễn phí hôm nay.",
      usage: aiReservation.status,
    }, 429);
  }

  let aiResult: unknown = null;
  try {
    aiResult = await (c.env.AI as any).run(RECEIPT_AI_MODEL, {
      messages: [
        {
          role: "system",
          content: "Bạn là bộ trích xuất dữ liệu hóa đơn. Luôn trả JSON hợp lệ, ưu tiên độ chính xác số tiền.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
      temperature: 0,
      max_completion_tokens: 6000,
      response_format: {
        type: "json_schema",
        json_schema: RECEIPT_JSON_SCHEMA,
      },
    });

    console.log("[receipt-ai] raw response", JSON.stringify(aiResult));
    const payload = getAiResponsePayload(aiResult);
    console.log("[receipt-ai] extracted payload", typeof payload === "string" ? payload : JSON.stringify(payload));

    const parsed = sanitizeReceiptParseResult(payload);
    console.log("[receipt-ai] parsed items", parsed.items.length, "total", parsed.totalAmount);
    await adjustAiNeuronReservation(
      c,
      aiReservation.reservation,
      estimateAiNeuronsFromResult(aiResult, aiReservation.reservation.reservedNeurons)
    );
    return c.json({ ...parsed, aiUsage: await getAiUsageStatus(c) });
  } catch (error) {
    await adjustAiNeuronReservation(
      c,
      aiReservation.reservation,
      aiResult ? estimateAiNeuronsFromResult(aiResult, aiReservation.reservation.reservedNeurons) : 0
    );
    console.error("[receipt-ai] failed", error, "raw response:", aiResult ? JSON.stringify(aiResult) : "<no response>");
    const message = error instanceof Error ? error.message : "Không đọc được hóa đơn";
    return c.json({
      error: `Không đọc được hóa đơn: ${message}`,
      aiRaw: aiResult ?? null,
      aiPayload: aiResult ? getAiResponsePayload(aiResult) : null,
    }, 502);
  }
});

sessions.post("/:id/costs", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<CostBody>();
  const label = body.label?.trim();
  const amount = Math.round(Number(body.amount));
  if (!label || !Number.isFinite(amount) || amount <= 0) return c.json({ error: "label, positive amount required" }, 400);

  const costId = nanoid();
  const quantity = normalizeQuantity(body.quantity);
  const payerId = body.payerId ?? body.payer_id ?? null;
  const consumerPending = body.consumer_pending ? 1 : 0;
  const consumerIds = consumerPending
    ? []
    : normalizeConsumerIds(body.consumerIds ?? body.consumer_ids, body.consumerId ?? body.consumer_id ?? null);
  const consumerId = consumerIds[0] ?? null;

  await c.env.DB.prepare(`
    INSERT INTO costs (id, session_id, label, amount, quantity, type, payer_id, consumer_id, consumer_ids, consumer_pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(costId, id, label, amount, quantity, body.type ?? "other", payerId, consumerId, encodeConsumerIds(consumerIds), consumerPending)
    .run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row, 201);
});

sessions.put("/:id/costs/:costId", async (c) => {
  const { id, costId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const existing = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ? AND session_id = ?")
    .bind(costId, id)
    .first<CostRow & { label: string; type: string }>();
  if (!existing) return c.json({ error: "Cost not found" }, 404);

  const body = await c.req.json<CostBody>();
  const label = body.label?.trim();
  const amount = Math.round(Number(body.amount));
  if (!label || !Number.isFinite(amount) || amount <= 0) return c.json({ error: "label, positive amount required" }, 400);

  const payerId = body.payerId ?? body.payer_id ?? null;
  const quantity = normalizeQuantity(body.quantity ?? existing.quantity ?? 1);
  const consumerPending = body.consumer_pending !== undefined
    ? (body.consumer_pending ? 1 : 0)
    : ((existing as any).consumer_pending ? 1 : 0);
  const consumerIds = consumerPending
    ? []
    : normalizeConsumerIds(body.consumerIds ?? body.consumer_ids, body.consumerId ?? body.consumer_id ?? null);
  const consumerId = consumerIds[0] ?? null;

  await c.env.DB.prepare(`
    UPDATE costs
    SET label = ?, amount = ?, quantity = ?, type = ?, payer_id = ?, consumer_id = ?, consumer_ids = ?, consumer_pending = ?
    WHERE id = ? AND session_id = ?
  `)
    .bind(label, amount, quantity, body.type ?? existing.type, payerId, consumerId, encodeConsumerIds(consumerIds), consumerPending, costId, id)
    .run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  const row = await c.env.DB.prepare("SELECT * FROM costs WHERE id = ?").bind(costId).first();
  return c.json(row);
});

sessions.delete("/:id/costs/:costId", async (c) => {
  const { id, costId } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM costs WHERE id = ?").bind(costId).run();
  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();
  return c.json({ success: true });
});

sessions.post("/:id/recalculate", async (c) => {
  const { id } = c.req.param();
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return c.json({ error: "Not found" }, 404);
  if (!(await canManageSession(c, session))) return c.json({ error: "Forbidden" }, 403);

  const attendees = await c.env.DB.prepare(
    "SELECT member_id FROM session_members WHERE session_id = ? AND attended = 1"
  ).bind(id).all<{ member_id: string }>();
  const eligibleMembers = session.group_id
    ? await c.env.DB.prepare("SELECT id FROM members WHERE group_id = ?")
      .bind(session.group_id)
      .all<{ id: string }>()
    : await c.env.DB.prepare("SELECT id FROM members")
      .all<{ id: string }>();

  const count = attendees.results.length;
  if (count === 0) return c.json({ error: "No attendees" }, 400);

  const attendeeIds = attendees.results.map((item) => item.member_id);
  const eligibleMemberSet = new Set(eligibleMembers.results.map((item) => item.id));
  const costs = await c.env.DB.prepare(
    "SELECT id, amount, payer_id, consumer_id, consumer_ids, consumer_pending FROM costs WHERE session_id = ?"
  ).bind(id).all<CostRow>();

  const payableCosts = costs.results.filter((cost) => !cost.consumer_pending);
  const sharedCosts = payableCosts.filter((cost) => getCostConsumerIds(cost).length === 0);
  const directCosts = payableCosts.filter((cost) => getCostConsumerIds(cost).length > 0);
  const fallbackRecipientId = normalizePaymentRecipient((session as any).payment_recipient as string | null | undefined);
  const forceCommonRecipient = Boolean((session as any).force_payment_recipient);

  if (fallbackRecipientId && !eligibleMemberSet.has(fallbackRecipientId)) {
    return c.json({ error: "Payment recipient must be an existing member" }, 400);
  }

  if (forceCommonRecipient && !fallbackRecipientId) {
    return c.json({ error: "Cần chọn người nhận chung trước khi bật chế độ này" }, 400);
  }

  const paymentMap = new Map<string, number>();
  const addPayment = (memberId: string | null | undefined, recipientMemberId: string | null | undefined, amount: number) => {
    if (!memberId || !recipientMemberId || memberId === recipientMemberId || amount <= 0) return;
    const key = `${memberId}:${recipientMemberId}`;
    paymentMap.set(key, (paymentMap.get(key) ?? 0) + amount);
  };

  for (const cost of sharedCosts) {
    const recipientId = forceCommonRecipient ? fallbackRecipientId : (cost.payer_id ?? fallbackRecipientId);
    if (!recipientId) {
      return c.json({ error: "Shared costs need a payer or a common payment recipient" }, 400);
    }
    if (!eligibleMemberSet.has(recipientId)) {
      return c.json({ error: "Payment recipient must be an existing member" }, 400);
    }

    const shares = splitAmountEvenly(cost.amount, count);
    for (let index = 0; index < attendeeIds.length; index += 1) {
      const attendeeId = attendeeIds[index];
      const share = shares[index];
      addPayment(attendeeId, recipientId, share);
    }
  }

  for (const cost of directCosts) {
    const recipientId = forceCommonRecipient ? fallbackRecipientId : (cost.payer_id ?? fallbackRecipientId);
    const consumerIds = getCostConsumerIds(cost);
    if (!recipientId || consumerIds.length === 0) {
      return c.json({ error: "Direct costs need a consumer and either a payer or a common payment recipient" }, 400);
    }
    if (!eligibleMemberSet.has(recipientId) || consumerIds.some((consumerId) => !eligibleMemberSet.has(consumerId))) {
      return c.json({ error: "Payer and consumer must both be existing members" }, 400);
    }
    const shares = splitAmountEvenly(cost.amount, consumerIds.length);
    for (let index = 0; index < consumerIds.length; index += 1) {
      addPayment(consumerIds[index], recipientId, shares[index]);
    }
  }

  // Khi force mode bật, người nhận chung cần trả lại cho từng người đã ứng tiền thực tế
  if (forceCommonRecipient && fallbackRecipientId) {
    const paybackByPayer = new Map<string, number>();
    for (const cost of costs.results) {
      if ((cost as any).consumer_pending) continue;
      if (!cost.payer_id || cost.payer_id === fallbackRecipientId) continue;
      if (!eligibleMemberSet.has(cost.payer_id)) continue;
      paybackByPayer.set(cost.payer_id, (paybackByPayer.get(cost.payer_id) ?? 0) + Math.round(cost.amount));
    }
    for (const [payerId, total] of paybackByPayer.entries()) {
      addPayment(fallbackRecipientId, payerId, total);
    }
  }

  // Net payments ngược chiều: nếu A nợ B và B nợ A thì chỉ giữ chiều chênh lệch
  for (const key of [...paymentMap.keys()]) {
    if (!paymentMap.has(key)) continue;
    const [memberId, recipientMemberId] = key.split(":");
    const reverseKey = `${recipientMemberId}:${memberId}`;
    const reverseAmount = paymentMap.get(reverseKey);
    if (!reverseAmount) continue;
    const forwardAmount = paymentMap.get(key)!;
    if (forwardAmount > reverseAmount) {
      paymentMap.set(key, forwardAmount - reverseAmount);
      paymentMap.delete(reverseKey);
    } else if (reverseAmount > forwardAmount) {
      paymentMap.set(reverseKey, reverseAmount - forwardAmount);
      paymentMap.delete(key);
    } else {
      paymentMap.delete(key);
      paymentMap.delete(reverseKey);
    }
  }

  const confirmedRows = await c.env.DB.prepare(
    "SELECT member_id, recipient_member_id, SUM(amount_owed) as confirmed_total FROM payments WHERE session_id = ? AND paid = 1 GROUP BY member_id, recipient_member_id"
  ).bind(id).all<{ member_id: string; recipient_member_id: string; confirmed_total: number }>();
  const confirmedMap = new Map<string, number>();
  for (const row of confirmedRows.results) {
    confirmedMap.set(`${row.member_id}:${row.recipient_member_id}`, row.confirmed_total);
  }

  await c.env.DB.prepare("DELETE FROM payments WHERE session_id = ? AND paid = 0").bind(id).run();

  const stmts: D1PreparedStatement[] = [];
  for (const [key, calculatedAmount] of paymentMap.entries()) {
    const confirmedAmount = confirmedMap.get(key) ?? 0;
    const remaining = calculatedAmount - confirmedAmount;
    if (remaining > 0) {
      const [memberId, recipientMemberId] = key.split(":");
      stmts.push(c.env.DB.prepare(`
        INSERT INTO payments (id, session_id, member_id, recipient_member_id, amount_owed, paid)
        VALUES (?, ?, ?, ?, ?, 0)
      `).bind(nanoid(), id, memberId, recipientMemberId, remaining));
    }
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const payments = await c.env.DB.prepare("SELECT * FROM payments WHERE session_id = ?").bind(id).all();

  const paymentNotificationRows = await c.env.DB.prepare(`
    SELECT
      debtor_user.email AS debtor_email,
      debtor_member.name AS debtor_name,
      recipient_member.name AS recipient_name,
      p.amount_owed
    FROM payments p
    JOIN members debtor_member ON debtor_member.id = p.member_id
    LEFT JOIN users debtor_user ON debtor_user.id = debtor_member.user_id
    LEFT JOIN members recipient_member ON recipient_member.id = p.recipient_member_id
    WHERE p.session_id = ?
      AND p.amount_owed > 0
      AND debtor_user.email IS NOT NULL
  `)
    .bind(id)
    .all<PaymentNotificationRow>();

  const isStrictManager = await canManageSessionStrict(c, session);

  if (isStrictManager && paymentNotificationRows.results.length > 0) {
    const grouped = new Map<string, { debtorName: string; lines: { recipientName: string; amount: number }[] }>();

    for (const item of paymentNotificationRows.results) {
      const email = item.debtor_email?.trim();
      if (!email) continue;
      const existing = grouped.get(email) ?? { debtorName: item.debtor_name, lines: [] };
      existing.lines.push({
        recipientName: item.recipient_name?.trim() || "người nhận",
        amount: item.amount_owed,
      });
      grouped.set(email, existing);
    }

    for (const [debtorEmail, payload] of grouped.entries()) {
      queueTask(c, sendPaymentDueNotification(c.env, {
        debtorEmail,
        debtorName: payload.debtorName,
        venue: String((session as any).venue ?? ""),
        date: String((session as any).date ?? ""),
        startTime: String((session as any).start_time ?? ""),
        sessionId: id,
        lines: payload.lines,
      }), `payment-due:${debtorEmail}`);
    }
  }

  return c.json(payments.results);
});

export default sessions;
