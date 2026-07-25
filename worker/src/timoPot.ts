// Đối soát thanh toán bằng lịch sử giao dịch "hũ" Timo, cấu hình theo từng nhóm.
//
// Thay cho đường Gmail cũ (scripts/timo-gmail-webhook.gs), vốn chỉ chạy được với hộp thư
// của một người → chỉ nhóm có người đó mới tự xác nhận được. Ở đây trưởng nhóm nào cũng
// dán link + mật mã hũ của mình vào cài đặt nhóm là nhóm đó tự xác nhận được.
//
// API không chính thức, moi ra từ JS của share.timo.vn (Next.js) rồi gọi thật để kiểm chứng:
//   POST https://app2.timo.vn/moneypots/public/alias/info
//        { hashVerifyCode, securityCode: null } → thông tin hũ, KHÔNG cần mật mã
//   POST https://app2.timo.vn/moneypots/public/txn
//        { size, xidIndex, hashVerifyCode, securityCode?, lang }
//        → { txnHistories: [{ dispDate, item: [...] }], lastIndex, potName, amount, ... }
// hashVerifyCode = SHA-512(mã trong URL share), securityCode = SHA-512(mật mã bảo vệ),
// cả hai hex thường. Không header auth, không cookie. Hũ không đặt mật mã thì bỏ securityCode.
//
// Lưu ý shape (đã kiểm chứng bằng hũ thật): txnHistories GOM THEO NGÀY, mỗi phần tử là
// { dispDate: "25/07/2025", item: [...] }; `size` đếm theo item chứ không theo ngày.
// txnAmount ÂM khi tiền ra khỏi hũ, DƯƠNG khi tiền vào. Nội dung chuyển khoản nằm ở txnDesc.

import { ensureTimoPotTables } from "./db/timoTables";
import { confirmPaymentTransfer, extractPaymentId } from "./paymentConfirm";
import { Env } from "./types";

const TIMO_API_BASE = "https://app2.timo.vn";
const PAGE_SIZE = 20;
// Trang đầu đã đủ cho nhịp 10 phút; nhiều trang chỉ dùng cho lần đồng bộ đầu và khi dồn
// giao dịch. Cố tình KHÔNG chốt ở một trang như bản Gmail cũ (chỉ quét 20 thread → mất giao dịch).
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 10_000;

export const TIMO_CODE = {
  SUCCESS: 200,
  MONEY_POT_EXPIRED: 5505,
  NOT_FOUND: 5515,
  WRONG_PASSWORD: 5516,
  LINK_EXPIRED: 5517,
  PASSWORD_REQUIRED: 6002,
} as const;

export function timoErrorMessage(code: number) {
  switch (code) {
    case TIMO_CODE.WRONG_PASSWORD:
      return "Mật mã bảo vệ của hũ không đúng";
    case TIMO_CODE.PASSWORD_REQUIRED:
      return "Hũ này yêu cầu mật mã bảo vệ — hãy nhập mật mã";
    case TIMO_CODE.LINK_EXPIRED:
      return "Link chia sẻ hũ đã hết hạn — tạo link mới trong app Timo";
    case TIMO_CODE.MONEY_POT_EXPIRED:
      return "Hũ đã đóng hoặc hết hạn";
    case TIMO_CODE.NOT_FOUND:
      return "Không tìm thấy hũ — kiểm tra lại link chia sẻ";
    default:
      return `Timo trả về mã lỗi ${code}`;
  }
}

export type TimoTxnItem = {
  txnTitle?: string | null;
  txnDesc?: string | null;
  txnAmount?: number | null;
  remainingAmount?: number | null;
  fromTimoBank?: boolean | null;
};

export type TimoTxnDateGroup = {
  dispDate?: string | null;
  item?: TimoTxnItem[] | null;
};

/** Một giao dịch đã làm phẳng: dispDate của nhóm ngày gộp vào từng item. */
export type TimoTxn = TimoTxnItem & { dispDate: string | null };

export type TimoTxnPage = {
  txnHistories?: TimoTxnDateGroup[] | null;
  lastIndex?: number | null;
  preXidIdx?: number | null;
  potName?: string | null;
  potIcon?: string | null;
  description?: string | null;
  amount?: number | null;
};

export type TimoAliasInfo = {
  /** Số tài khoản RIÊNG của hũ (vd TIMO90C0908A658) — đây là số để nhận tiền vào hũ. */
  accountNumber?: string | null;
  /**
   * CẢNH BÁO: đây là tài khoản CHÍNH của chủ hũ, KHÔNG phải của hũ — hai hũ khác nhau
   * của cùng một người trả về cùng một số. Dùng số này cho QR thì tiền không vào hũ.
   */
  altAccountNumber?: string | null;
  sourceMoney?: string | null;
  fullName?: string | null;
  bankName?: string | null;
  bankNameDomestic?: string | null;
  bankShortName?: string | null;
  aliasStatus?: boolean | null;
};

export type TimoPotConfig = {
  id: string;
  timo_verify_code?: string | null;
  timo_security_hash?: string | null;
};

async function hashHex(algorithm: "SHA-512" | "SHA-256", input: string) {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const sha512Hex = (input: string) => hashHex("SHA-512", input);
export const sha256Hex = (input: string) => hashHex("SHA-256", input);

// Nhận cả URL đầy đủ (https://share.timo.vn/VN/transaction/xxxx) và mã trần.
export function parseShareCode(input: string) {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/transaction\/([A-Za-z0-9_-]+)/);
  return (fromUrl?.[1] ?? trimmed).trim();
}

export function shareUrlFromCode(verifyCode: string) {
  return `https://share.timo.vn/VN/transaction/${verifyCode}`;
}

type TimoResponse<T> = { code?: number; success?: boolean; data?: T };

async function postTimo<T>(path: string, body: unknown): Promise<TimoResponse<T>> {
  const response = await fetch(`${TIMO_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json, text/plain",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Timo HTTP ${response.status}`);
  return (await response.json()) as TimoResponse<T>;
}

/**
 * Thông tin hũ — dùng để xác minh link và lấy số tài khoản của hũ.
 * Mức bảo vệ khác nhau giữa các hũ (đã gặp thật): có hũ trả 200 khi securityCode null,
 * có hũ trả 6002 ngay ở đây. Nên luôn gửi kèm mật mã nếu có.
 */
export async function fetchAliasInfo(verifyCode: string, securityHash?: string | null) {
  const hashVerifyCode = await sha512Hex(verifyCode);
  return postTimo<TimoAliasInfo>("/moneypots/public/alias/info", {
    hashVerifyCode,
    securityCode: securityHash ?? null,
  });
}

/** Một trang lịch sử. xidIndex = lastIndex của trang trước; lastIndex === -1 là hết. */
export async function fetchTxnPage(args: {
  hashVerifyCode: string;
  securityHash?: string | null;
  xidIndex?: number;
}) {
  const body: Record<string, unknown> = {
    size: PAGE_SIZE,
    xidIndex: args.xidIndex ?? 0,
    hashVerifyCode: args.hashVerifyCode,
    lang: "VN",
  };
  if (args.securityHash) body.securityCode = args.securityHash;

  return postTimo<TimoTxnPage>("/moneypots/public/txn", body);
}

export function flattenTxnPage(page?: TimoTxnPage | null): TimoTxn[] {
  const flat: TimoTxn[] = [];
  for (const group of page?.txnHistories ?? []) {
    for (const item of group?.item ?? []) {
      flat.push({ ...item, dispDate: group?.dispDate ?? null });
    }
  }
  return flat;
}

// Giao dịch Timo không có id/refNo → fingerprint để chống xử lý trùng.
// remainingAmount (số dư sau giao dịch) nằm trong khoá: hai lần chuyển giống nhau hệt
// vẫn khác số dư, nên không bị gộp thành một.
async function txnFingerprint(txn: TimoTxn) {
  return sha256Hex(
    [txn.dispDate ?? "", txn.txnAmount ?? "", txn.remainingAmount ?? "", txn.txnDesc ?? ""].join("|")
  );
}

// dispDate dạng dd/MM/yyyy. Đổi sang ISO để lưu paid_at cho đúng ngày.
function parseTxnDate(value?: string | null) {
  if (!value) return null;

  const dmy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00.000Z`;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type PollSummary = {
  groupId: string;
  scanned: number;
  confirmed: number;
  pages: number;
  error: string | null;
};

// Kết quả có thể đổi về sau nên phải quét lại, KHÔNG chốt vĩnh viễn:
//  - recipient_not_eligible: nhóm khai sai số tài khoản hũ, sửa xong phải xác nhận được
//  - amount_mismatch: chi phí buổi được sửa sau đó → số tiền phải trả thay đổi theo
// Cố tình KHÔNG cho 'pending' vào đây để giữ tính khoá của claim (xem releaseTxn).
const RETRYABLE_OUTCOMES = ["recipient_not_eligible", "amount_mismatch"];

/**
 * Đặt chỗ xử lý một giao dịch — trả true nếu giành được quyền xử lý.
 * Lần đầu thì INSERT; đã có rồi thì chỉ giành lại nếu kết quả cũ thuộc RETRYABLE_OUTCOMES.
 * Nhờ vậy cron và "kiểm tra ngay" chạy song song không xác nhận trùng, mà giao dịch
 * từng thất bại vì cấu hình sai vẫn được thử lại sau khi sửa.
 */
async function claimTxn(env: Env, groupId: string, fingerprint: string, txn: TimoTxn) {
  const result = await env.DB.prepare(`
    INSERT INTO timo_seen_txn
      (group_id, fingerprint, txn_date, amount, remaining_amount, txn_title, txn_desc,
       from_timo_bank, payment_id, outcome, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)
    ON CONFLICT(group_id, fingerprint) DO UPDATE SET
      outcome = 'pending',
      payment_id = NULL,
      seen_at = excluded.seen_at
    WHERE timo_seen_txn.outcome IN (${RETRYABLE_OUTCOMES.map(() => "?").join(", ")})
  `)
    .bind(
      groupId,
      fingerprint,
      txn.dispDate ?? null,
      typeof txn.txnAmount === "number" ? txn.txnAmount : null,
      typeof txn.remainingAmount === "number" ? txn.remainingAmount : null,
      txn.txnTitle ?? null,
      txn.txnDesc ?? null,
      txn.fromTimoBank ? 1 : 0,
      new Date().toISOString(),
      ...RETRYABLE_OUTCOMES
    )
    .run();

  return Boolean(result.meta?.changes);
}

async function recordOutcome(
  env: Env,
  groupId: string,
  fingerprint: string,
  outcome: string,
  paymentId: string | null
) {
  await env.DB.prepare(
    "UPDATE timo_seen_txn SET outcome = ?, payment_id = ? WHERE group_id = ? AND fingerprint = ?"
  )
    .bind(outcome, paymentId, groupId, fingerprint)
    .run();
}

// Nhả chỗ đã đặt để lần chạy sau thử lại — tránh mất giao dịch khi lỗi tạm thời.
async function releaseTxn(env: Env, groupId: string, fingerprint: string) {
  await env.DB.prepare("DELETE FROM timo_seen_txn WHERE group_id = ? AND fingerprint = ?")
    .bind(groupId, fingerprint)
    .run();
}

async function processTxn(
  env: Env,
  group: TimoPotConfig,
  txn: TimoTxn,
  defer?: (task: Promise<unknown>) => void
): Promise<{ outcome: string; paymentId: string | null }> {
  const amount = typeof txn.txnAmount === "number" ? txn.txnAmount : 0;

  // Tiền ra khỏi hũ (txnAmount âm) thì không phải ai đó trả tiền.
  if (amount <= 0) return { outcome: "not_incoming", paymentId: null };

  // Mã nằm ở txnDesc, nhưng quét cả txnTitle cho chắc.
  const paymentId = extractPaymentId(`${txn.txnDesc ?? ""} ${txn.txnTitle ?? ""}`);
  // Nạp/rút nội bộ giữa các hũ cũng là tiền vào — không có mã CLD nên rơi vào đây.
  if (!paymentId) return { outcome: "no_payment_code", paymentId: null };

  const result = await confirmPaymentTransfer(env, {
    paymentId,
    amount,
    paidAt: parseTxnDate(txn.dispDate),
    expectGroupId: group.id,
    requirePotSession: true,
    defer,
  });

  return { outcome: result.status, paymentId };
}

/** Quét lịch sử giao dịch của một nhóm và xác nhận những payment khớp mã + số tiền. */
export async function pollGroupPot(
  env: Env,
  group: TimoPotConfig,
  opts?: { defer?: (task: Promise<unknown>) => void }
): Promise<PollSummary> {
  const summary: PollSummary = {
    groupId: group.id,
    scanned: 0,
    confirmed: 0,
    pages: 0,
    error: null,
  };

  const verifyCode = group.timo_verify_code?.trim();
  if (!verifyCode) {
    summary.error = "Nhóm chưa cấu hình link hũ Timo";
    return summary;
  }

  await ensureTimoPotTables(env.DB);

  try {
    const hashVerifyCode = await sha512Hex(verifyCode);
    let xidIndex = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchTxnPage({
        hashVerifyCode,
        securityHash: group.timo_security_hash,
        xidIndex,
      });

      if (response.code !== TIMO_CODE.SUCCESS) {
        summary.error = timoErrorMessage(response.code ?? 0);
        break;
      }

      summary.pages += 1;

      let unseen = 0;
      for (const txn of flattenTxnPage(response.data)) {
        summary.scanned += 1;

        const fingerprint = await txnFingerprint(txn);
        if (!(await claimTxn(env, group.id, fingerprint, txn))) continue;
        unseen += 1;

        try {
          const { outcome, paymentId } = await processTxn(env, group, txn, opts?.defer);
          await recordOutcome(env, group.id, fingerprint, outcome, paymentId);
          if (outcome === "confirmed") summary.confirmed += 1;
        } catch (error) {
          await releaseTxn(env, group.id, fingerprint);
          throw error;
        }
      }

      const lastIndex = response.data?.lastIndex ?? -1;
      if (lastIndex === -1) break;
      // Cả trang đều đã xử lý → phía sau càng cũ, không cần quét tiếp.
      if (unseen === 0) break;
      xidIndex = lastIndex;
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE groups
    SET timo_last_checked_at = ?,
        timo_last_ok_at = COALESCE(?, timo_last_ok_at),
        timo_last_error = ?
    WHERE id = ?
  `)
    .bind(now, summary.error ? null : now, summary.error, group.id)
    .run();

  return summary;
}

// Nhịp quét định kỳ: 1 tiếng/nhóm, để không đụng rate limit của Timo. Người trả tiền bấm
// "đã chuyển" thì có đường riêng (route .../payment-settings/check) không phải chờ nhịp này.
export const POT_POLL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Quét những nhóm đã quá hạn 1 tiếng. Gọi được từ cả cron lẫn request thường —
 * môi trường serverless không đảm bảo cron nổ đúng giờ, nên request đến cũng kích hoạt.
 * @param groupIds giới hạn trong một số nhóm (vd nhóm của user đang gọi API)
 */
export async function pollStalePots(env: Env, opts?: { groupIds?: string[] }) {
  await ensureTimoPotTables(env.DB);

  const cutoff = new Date(Date.now() - POT_POLL_INTERVAL_MS).toISOString();
  let sql = `
    SELECT id, timo_verify_code, timo_security_hash
    FROM groups
    WHERE timo_verify_code IS NOT NULL AND timo_verify_code != ''
      AND (timo_last_checked_at IS NULL OR timo_last_checked_at < ?)
  `;
  const binds: unknown[] = [cutoff];

  if (opts?.groupIds?.length) {
    sql += ` AND id IN (${opts.groupIds.map(() => "?").join(", ")})`;
    binds.push(...opts.groupIds);
  }

  const rows = await env.DB.prepare(sql).bind(...binds).all<TimoPotConfig>();
  if (rows.results.length === 0) return [];

  // Đặt cọc mốc thời gian TRƯỚC khi quét: request/cron chạy đồng thời sẽ không còn thấy
  // các nhóm này là "đến hạn", nên không gọi Timo trùng lặp.
  const now = new Date().toISOString();
  await env.DB.batch(
    rows.results.map((group) =>
      env.DB.prepare("UPDATE groups SET timo_last_checked_at = ? WHERE id = ?").bind(now, group.id)
    )
  );

  const summaries: PollSummary[] = [];
  for (const group of rows.results) {
    summaries.push(await pollGroupPot(env, group));
  }

  return summaries;
}
