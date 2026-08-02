import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Session } from "@/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount)) + "đ";
}

export function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

export function getSessionTitle(session: Pick<Session, "name" | "venue">): string {
  return session.name?.trim() || session.venue;
}

export function formatSessionTimeRange(session: Pick<Session, "start_time" | "end_time">): string {
  return session.end_time ? `${session.start_time} - ${session.end_time}` : session.start_time;
}

export function formatDateLong(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(-2)
    .join("")
    .toUpperCase();
}

/**
 * Chuẩn hoá tên + ảnh của thành viên về ĐÚNG hồ sơ thật.
 *
 * members.name/avatar_color chỉ là bản chụp lúc tạo thành viên, và với người đã có tài khoản
 * thì chỉ site-admin mới sửa được — nên khi người dùng tự đổi tên/ảnh trong hồ sơ, bản chụp
 * trôi lại phía sau mà nhóm không tự sửa nổi. Ưu tiên dữ liệu hồ sơ khi member gắn tài khoản;
 * vãng lai không có user_id nên giữ nguyên tên đã nhập cho buổi đó.
 *
 * Gọi MỘT lần lúc dựng danh sách rồi dùng lại, đừng chép logic này ra từng chỗ hiển thị.
 */
export function withRealIdentity<T extends {
  name: string;
  user_id?: string;
  user_name?: string | null;
  user_avatar_url?: string | null;
}>(member: T): T {
  if (!member.user_id) return member;
  const realName = member.user_name?.trim();
  return realName && realName !== member.name ? { ...member, name: realName } : member;
}

/** URL ảnh đại diện thật; rỗng thì trả undefined để Avatar tự vẽ chữ cái đầu. */
export function memberAvatarUrl(member: { user_avatar_url?: string | null }): string | undefined {
  return member.user_avatar_url?.trim() || undefined;
}
