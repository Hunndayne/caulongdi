// Chu kỳ nhắc công nợ: chuẩn hoá cấu hình + trả lời "hôm nay có nhắc không".
// Tách riêng vì cron (botOutbox.ts) và API cài đặt (routes/groups.ts) phải hiểu
// GIỐNG HỆT nhau về mặc định và cách tính kỳ — lệch một chút là nhóm bị nhắc sai ngày.
//
// Mọi hàm ở đây nhận `vnNow` là Date đã dịch sang giờ VN (xem vnNowDate trong botOutbox.ts)
// và đọc bằng getUTC* — nên getUTCDay() chính là thứ theo lịch Việt Nam.

export const DEBT_REMINDER_DEFAULT_TIME = "20:00";
export const DEBT_REMINDER_DEFAULT_INTERVAL_DAYS = 3;
/** 0 = Chủ nhật … 6 = Thứ 7 (theo Date.getUTCDay). Mặc định Thứ 2 cho gọn đầu tuần. */
export const DEBT_REMINDER_DEFAULT_WEEKDAY = 1;
export const DEBT_REMINDER_MIN_INTERVAL_DAYS = 2;
export const DEBT_REMINDER_MAX_INTERVAL_DAYS = 30;
/** Cron chạy 10'/lần; cửa sổ 30' cho cron lỡ nhịp vẫn kịp, dedupe theo ngày lo phần chỉ gửi 1 lần. */
export const DEBT_REMINDER_WINDOW_MINUTES = 30;

/** daily: mỗi ngày • every_n_days: cách N ngày tính từ mốc • weekly: mỗi tuần vào 1 thứ • monthly_end: ngày cuối tháng. */
export type DebtReminderCycle = "daily" | "every_n_days" | "weekly" | "monthly_end";

export const DEBT_REMINDER_CYCLES: DebtReminderCycle[] = ["daily", "every_n_days", "weekly", "monthly_end"];

/** Các cột `groups.debt_reminder_*` đọc lên từ D1. */
export type DebtReminderColumns = {
  debt_reminder_enabled?: number | null;
  debt_reminder_time?: string | null;
  debt_reminder_cycle?: string | null;
  debt_reminder_interval_days?: number | null;
  debt_reminder_weekday?: number | null;
  debt_reminder_anchor_date?: string | null;
};

export type DebtReminderConfig = {
  enabled: boolean;
  time: string;
  cycle: DebtReminderCycle;
  /** Chỉ có nghĩa khi cycle = every_n_days. */
  intervalDays: number;
  /** Chỉ có nghĩa khi cycle = weekly. */
  weekday: number;
  /** Mốc đếm kỳ của every_n_days, dạng "YYYY-MM-DD" giờ VN. */
  anchorDate: string | null;
};

/** "HH:MM" hợp lệ thì trả lại, không thì dùng mặc định. */
export function normalizeReminderTime(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  return isValidReminderTime(t) ? t : DEBT_REMINDER_DEFAULT_TIME;
}

export function isValidReminderTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Cột rỗng/NULL (nhóm có từ trước khi có chu kỳ) = hằng ngày, đúng hành vi cũ. */
export function normalizeCycle(value: string | null | undefined): DebtReminderCycle {
  const c = (value ?? "").trim();
  return (DEBT_REMINDER_CYCLES as string[]).includes(c) ? (c as DebtReminderCycle) : "daily";
}

export function normalizeIntervalDays(value: number | null | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEBT_REMINDER_DEFAULT_INTERVAL_DAYS;
  if (n < DEBT_REMINDER_MIN_INTERVAL_DAYS || n > DEBT_REMINDER_MAX_INTERVAL_DAYS) {
    return DEBT_REMINDER_DEFAULT_INTERVAL_DAYS;
  }
  return n;
}

export function normalizeWeekday(value: number | null | undefined): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 6 ? n : DEBT_REMINDER_DEFAULT_WEEKDAY;
}

/** Đọc cấu hình từ một dòng `groups`, vá sẵn mọi giá trị thiếu/hỏng. */
export function readDebtReminder(row: DebtReminderColumns): DebtReminderConfig {
  return {
    enabled: Boolean(row.debt_reminder_enabled),
    time: normalizeReminderTime(row.debt_reminder_time),
    cycle: normalizeCycle(row.debt_reminder_cycle),
    intervalDays: normalizeIntervalDays(row.debt_reminder_interval_days),
    weekday: normalizeWeekday(row.debt_reminder_weekday),
    anchorDate: parseDateOnly(row.debt_reminder_anchor_date) ? (row.debt_reminder_anchor_date ?? "").trim() : null,
  };
}

/** Ngày "YYYY-MM-DD" theo giờ VN của thời điểm đang xét. */
export function vnDateString(vnNow: Date): string {
  return vnNow.toISOString().slice(0, 10);
}

/** Phút trong ngày (giờ VN) — dùng để so với giờ nhắc đã đặt. */
export function minutesOfDay(vnNow: Date): number {
  return vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();
}

export function timeToMinutes(time: string): number {
  const [hh, mm] = normalizeReminderTime(time).split(":");
  return Number(hh) * 60 + Number(mm);
}

/** Hôm nay (giờ VN) có rơi đúng kỳ nhắc không — chưa xét giờ. */
export function shouldRemindOn(config: DebtReminderConfig, vnNow: Date): boolean {
  switch (config.cycle) {
    case "weekly":
      return vnNow.getUTCDay() === config.weekday;
    case "monthly_end":
      return isLastDayOfMonth(vnNow);
    case "every_n_days": {
      const diff = daysSinceAnchor(config.anchorDate, vnNow);
      // Mốc ở tương lai (dữ liệu nhập tay) thì chưa tới kỳ nào cả.
      return diff >= 0 && diff % config.intervalDays === 0;
    }
    default:
      return true;
  }
}

/**
 * Ngày nhắc kế tiếp, dạng "YYYY-MM-DD" giờ VN — để UI nói rõ "cách 3 ngày" là từ mốc nào.
 * Hôm nay đã qua giờ nhắc thì tính từ ngày mai.
 */
export function nextRunDate(config: DebtReminderConfig, vnNow: Date): string {
  const startOffset = minutesOfDay(vnNow) >= timeToMinutes(config.time) ? 1 : 0;
  // 400 ngày là thừa cho mọi chu kỳ hiện có; có vòng chặn để không bao giờ lặp vô hạn.
  for (let offset = startOffset; offset <= 400; offset += 1) {
    const day = new Date(vnNow.getTime() + offset * 86400000);
    if (shouldRemindOn(config, day)) return vnDateString(day);
  }
  return "";
}

function isLastDayOfMonth(vnNow: Date): boolean {
  const tomorrow = new Date(vnNow.getTime() + 86400000);
  return tomorrow.getUTCMonth() !== vnNow.getUTCMonth();
}

/** Số ngày từ mốc tới hôm nay. Không có mốc hợp lệ thì đếm từ epoch — vẫn đều, chỉ không canh theo ngày bật. */
function daysSinceAnchor(anchorDate: string | null, vnNow: Date): number {
  const today = epochDay(vnNow);
  const anchor = parseDateOnly(anchorDate);
  return anchor === null ? today : today - anchor;
}

function epochDay(vnNow: Date): number {
  return Math.floor(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate()) / 86400000);
}

/** "YYYY-MM-DD" → số ngày kể từ epoch, hoặc null nếu không đúng dạng. */
function parseDateOnly(value: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}
