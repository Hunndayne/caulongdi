import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  Calendar,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  Info,
  Plus,
  SlidersHorizontal,
  User,
  Users,
} from "lucide-react";
import { api } from "@/api/client";
import { useSession } from "@/lib/auth-client";
import { useSessionsStore } from "@/stores/sessionsStore";
import { EmptyState } from "@/components/shared/EmptyState";
import { GroupSelector } from "@/components/shared/GroupSelector";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { MemberStats, Session } from "@/types";

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const HOURS = Array.from({ length: 15 }, (_, index) => index + 7);

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthTitle(date: Date) {
  return new Intl.DateTimeFormat("vi-VN", { month: "long", year: "numeric" }).format(date);
}

function monthTag(date: Date) {
  return `TH ${date.getMonth() + 1}`;
}

function parseSessionDateTime(session: Session) {
  const [year, month, day] = session.date.split("-").map(Number);
  const [hour = 0, minute = 0] = session.start_time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function compareSessionAsc(a: Session, b: Session) {
  return `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`);
}

function compareSessionDesc(a: Session, b: Session) {
  return compareSessionAsc(b, a);
}

function toIcsDate(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcs(value?: string | null) {
  return (value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function downloadCalendarFile(session: Session) {
  const start = parseSessionDateTime(session);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const location = [session.venue, session.location].filter(Boolean).join(" - ");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TingTing//Session Calendar//VI",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${session.id}@tingting.app`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcs(`TingTing - ${session.venue}`)}`,
    `LOCATION:${escapeIcs(location)}`,
    `DESCRIPTION:${escapeIcs(session.note || "Buổi hẹn TingTing")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeVenue = session.venue.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  link.href = url;
  link.download = `${session.date}-${safeVenue || "tingting"}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildMonthCells(month: Date) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const leadingEmptyDays = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: leadingEmptyDays }, () => null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, monthIndex, day));
  }

  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function buildWeekDays(anchor: Date) {
  const dayIndex = (anchor.getDay() + 6) % 7;
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - dayIndex);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return date;
  });
}

function eventTop(session: Session) {
  const [hour = 7, minute = 0] = session.start_time.split(":").map(Number);
  const top = ((hour - 7) + minute / 60) * 60;
  return Math.max(0, Math.min(top, HOURS.length * 60 - 56));
}

type CalendarView = "month" | "week";

function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  tone = "green",
  className,
}: {
  icon: typeof Calendar;
  label: string;
  value: string | number;
  trend: string;
  tone?: "green" | "amber" | "red";
  className?: string;
}) {
  const toneClass = {
    green: "bg-[#e7f6ec] text-[#16a34a]",
    amber: "bg-[#fbf2dc] text-[#b07410]",
    red: "bg-[#fdecec] text-[#dc2626]",
  }[tone];

  return (
    <div className={cn("flex flex-col gap-2.5 rounded-[14px] border border-[#e8e7e2] bg-white px-[18px] py-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-[#71717a]">
          <Icon size={14} />
          {label}
        </div>
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-[#e8e7e2] text-[10px] text-[#a1a1aa]">
          i
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <div className="text-[26px] font-bold leading-none tracking-normal text-[#18181b]">{value}</div>
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${toneClass}`}>
          {tone === "green" && <ChevronRight size={11} className="-rotate-90" />}
          {trend}
        </span>
      </div>
    </div>
  );
}

function SessionThumb({ kind }: { kind: "personal" | "group" }) {
  if (kind === "personal") {
    return (
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-gradient-to-br from-[#16a34a] to-[#064e1d] text-white">
        <span className="absolute inset-1.5 rounded-[3px] border border-white/50" />
        <span className="absolute bottom-1.5 top-1.5 h-auto w-px bg-white/50" />
      </div>
    );
  }

  return (
    <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-gradient-to-br from-[#dc2626] to-[#7f1d1d] text-white">
      <Users size={18} />
    </div>
  );
}

function StatusChip({ children, tone }: { children: React.ReactNode; tone: "upcoming" | "confirmed" | "pending" }) {
  const classes = {
    upcoming: "bg-[#e7f6ec] text-[#16a34a]",
    confirmed: "border border-[#e8e7e2] bg-[#f7f7f5] text-[#3f3f46]",
    pending: "bg-[#fbf2dc] text-[#b07410]",
  }[tone];

  return <span className={`whitespace-nowrap rounded-full px-[9px] py-1 text-[11px] font-semibold ${classes}`}>{children}</span>;
}

type MarqueeStyle = CSSProperties & {
  "--session-title-distance"?: string;
  "--session-title-duration"?: string;
};

function SessionTitle({ text, marquee }: { text: string; marquee: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useEffect(() => {
    if (!marquee) {
      setOverflowDistance(0);
      return;
    }

    const updateOverflow = () => {
      const container = containerRef.current;
      const textElement = textRef.current;
      if (!container || !textElement) return;

      const distance = Math.ceil(textElement.scrollWidth - container.clientWidth);
      setOverflowDistance(distance > 4 ? distance : 0);
    };

    updateOverflow();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    if (resizeObserver && containerRef.current && textRef.current) {
      resizeObserver.observe(containerRef.current);
      resizeObserver.observe(textRef.current);
    }

    window.addEventListener("resize", updateOverflow);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateOverflow);
    };
  }, [marquee, text]);

  const shouldMarquee = marquee && overflowDistance > 0;
  const style: MarqueeStyle | undefined = shouldMarquee
    ? {
        "--session-title-distance": `${overflowDistance}px`,
        "--session-title-duration": `${Math.min(18, Math.max(7, overflowDistance / 16))}s`,
      }
    : undefined;

  return (
    <div
      ref={containerRef}
      className="min-w-0 overflow-hidden text-[13.5px] font-semibold text-[#18181b]"
      title={text}
    >
      <span
        ref={textRef}
        className={cn("block whitespace-nowrap", shouldMarquee ? "session-title-marquee" : "truncate")}
        style={style}
      >
        {text}
      </span>
    </div>
  );
}

function SessionRow({
  session,
  kind,
  joined,
}: {
  session: Session;
  kind: "personal" | "group";
  joined?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#e8e7e2] bg-white px-3.5 py-3 transition-colors hover:border-[#18181b]">
      <SessionThumb kind={kind} />
      <Link to={`/sessions/${session.id}`} className="min-w-0 flex-1 overflow-hidden">
        <SessionTitle text={session.venue} marquee={kind === "group"} />
        <div className="mt-0.5 truncate text-xs text-[#71717a]">
          {formatDate(session.date)} · {session.start_time}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        {kind === "group" ? (
          joined ? <StatusChip tone="confirmed">Đã đăng ký</StatusChip> : <StatusChip tone="pending">Chưa đăng ký</StatusChip>
        ) : (
          <StatusChip tone="upcoming">Sắp tới</StatusChip>
        )}
        {kind === "group" && !joined ? (
          <Link
            to={`/sessions/${session.id}`}
            className="hidden rounded-lg bg-[#18181b] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#3f3f46] min-[769px]:inline-flex"
          >
            Đăng ký
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => downloadCalendarFile(session)}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-[#e8e7e2] bg-white text-[#3f3f46] transition-colors hover:bg-[#f7f7f5] hover:text-[#18181b]"
            aria-label="Thêm vào lịch"
            title="Thêm vào lịch"
          >
            <CalendarPlus size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const { data: session } = useSession();
  const { sessions, fetch } = useSessionsStore();
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [myStats, setMyStats] = useState<MemberStats | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [calendarView, setCalendarView] = useState<CalendarView>("month");
  const [joinedSessions, setJoinedSessions] = useState<Session[]>([]);
  const [joinedLoading, setJoinedLoading] = useState(true);

  useEffect(() => {
    fetch(selectedGroupId);
    api.getStats(selectedGroupId)
      .then((response) => {
        const currentUserId = (session?.user as { id?: string } | undefined)?.id;
        setMyStats(response.memberStats.find((item) => item.userId === currentUserId) ?? null);
      })
      .catch(() => {});
  }, [fetch, selectedGroupId, session?.user]);

  useEffect(() => {
    setJoinedLoading(true);
    api.getJoinedSessions(selectedGroupId)
      .then(setJoinedSessions)
      .catch(() => setJoinedSessions([]))
      .finally(() => setJoinedLoading(false));
  }, [selectedGroupId]);

  const joinedIds = useMemo(() => new Set(joinedSessions.map((item) => item.id)), [joinedSessions]);
  const calendarSessions = sessions;
  const thisMonth = monthKey(new Date());
  const activeMonth = monthKey(calendarMonth);
  const myThisMonthCount = joinedSessions.filter((item) => item.date.startsWith(thisMonth)).length;
  const myActiveMonthCount = joinedSessions.filter((item) => item.date.startsWith(activeMonth)).length;
  const groupActiveMonthCount = sessions.filter((item) => item.date.startsWith(activeMonth)).length;
  const today = dateKey(new Date());

  const sessionsByDate = useMemo(() => {
    return calendarSessions.reduce<Record<string, Session[]>>((acc, item) => {
      acc[item.date] = [...(acc[item.date] ?? []), item].sort(compareSessionAsc);
      return acc;
    }, {});
  }, [calendarSessions]);

  const monthCells = useMemo(() => buildMonthCells(calendarMonth), [calendarMonth]);
  const weekDays = useMemo(() => buildWeekDays(calendarMonth), [calendarMonth]);
  const myUpcoming = useMemo(
    () => joinedSessions.filter((item) => item.status === "upcoming").sort(compareSessionAsc),
    [joinedSessions]
  );
  const groupUpcoming = useMemo(
    () => sessions.filter((item) => item.status === "upcoming").sort(compareSessionAsc).slice(0, 5),
    [sessions]
  );
  const myCompleted = useMemo(
    () => joinedSessions.filter((item) => item.status === "completed").sort(compareSessionDesc),
    [joinedSessions]
  );

  const changeMonth = (amount: number) => {
    setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  const userName = session?.user.name ?? "bạn";
  const debt = myStats?.debt ?? 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-normal text-[#18181b]">Xin chào, {userName}</h1>
          <div className="mt-1 text-[13px] text-[#71717a]">Tổng quan hoạt động và buổi chơi sắp tới</div>
        </div>
        <div className="flex gap-2">
          <a
            href="#group-filter"
            className="inline-flex items-center gap-2 rounded-[9px] border border-[#e8e7e2] bg-white px-3 py-2 text-[13px] font-medium text-[#18181b] transition-colors hover:bg-[#f7f7f5]"
          >
            <SlidersHorizontal size={14} />
            Bộ lọc
          </a>
          <Link
            to="/sessions"
            className="inline-flex items-center gap-2 rounded-[9px] bg-[#18181b] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#3f3f46]"
          >
            <Plus size={14} />
            Tạo buổi chơi
          </Link>
        </div>
      </div>

      <section className="mb-[18px] grid gap-3.5 min-[769px]:grid-cols-2 min-[1025px]:grid-cols-3">
        <StatCard icon={CalendarDays} label="Buổi tháng này" value={myThisMonthCount} trend={`${myUpcoming.length} sắp tới`} />
        <StatCard icon={CheckCircle2} label="Đã tham gia" value={joinedSessions.length} trend={`${myCompleted.length} đã hoàn thành`} />
        <StatCard
          icon={DollarSign}
          label="Còn nợ"
          value={formatCurrency(debt)}
          trend={debt > 0 ? "Cần nộp" : "Đã ổn"}
          tone={debt > 0 ? "amber" : "green"}
          className="min-[769px]:col-span-2 min-[1025px]:col-span-1"
        />
      </section>

      <div id="group-filter">
        <GroupSelector
          value={selectedGroupId}
          onChange={setSelectedGroupId}
          allowAll
          allLabel="Tổng hợp tất cả nhóm"
        />
      </div>

      <div className="grid gap-[18px] min-[1101px]:grid-cols-[1.6fr_1fr]">
        <section className="rounded-[14px] border border-[#e8e7e2] bg-white p-3.5 min-[769px]:p-[18px]">
          <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="min-w-11 overflow-hidden rounded-[9px] border border-[#e8e7e2] bg-white text-center">
                <div className="bg-[#18181b] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[1px] text-white">
                  {monthTag(calendarMonth)}
                </div>
                <div className="px-2 py-1 text-base font-bold text-[#18181b]">{new Date().getDate()}</div>
              </div>
              <div>
                <div className="text-base font-bold capitalize tracking-normal text-[#18181b]">{monthTitle(calendarMonth)}</div>
                <div className="mt-0.5 text-xs text-[#71717a]">
                  {myActiveMonthCount} buổi cá nhân · {groupActiveMonthCount} buổi nhóm
                </div>
              </div>
            </div>

            <div className="flex w-full flex-wrap items-center justify-start gap-1.5 min-[640px]:w-auto min-[640px]:justify-end">
              <button
                type="button"
                onClick={() => changeMonth(-1)}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-[#e8e7e2] bg-white text-[#3f3f46] hover:bg-[#f7f7f5]"
                aria-label="Tháng trước"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => setCalendarMonth(new Date())}
                className="rounded-lg border border-[#e8e7e2] bg-white px-3 py-1.5 text-xs font-semibold text-[#18181b] hover:bg-[#f7f7f5]"
              >
                Hôm nay
              </button>
              <button
                type="button"
                onClick={() => changeMonth(1)}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-[#e8e7e2] bg-white text-[#3f3f46] hover:bg-[#f7f7f5]"
                aria-label="Tháng sau"
              >
                <ChevronRight size={14} />
              </button>

              <div className="flex rounded-[9px] border border-[#e8e7e2] bg-[#f7f7f5] p-[3px]">
                {(["month", "week"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setCalendarView(view)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      calendarView === view ? "bg-white text-[#18181b] shadow-sm" : "text-[#71717a] hover:text-[#18181b]"
                    }`}
                  >
                    {view === "month" ? "Tháng" : "Tuần"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {calendarView === "month" ? (
            <div>
              <div className="min-w-0">
                <div className="grid grid-cols-7 border-b border-[#e8e7e2]">
                  {WEEKDAYS.map((day) => (
                    <div key={day} className="py-2 text-center text-[11px] font-semibold uppercase tracking-[.5px] text-[#71717a]">
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 border-l border-t border-[#efeeea]">
                  {monthCells.map((day, index) => {
                    if (!day) {
                      return (
                        <div
                          key={`empty-${index}`}
                          className="min-h-16 border-b border-r border-[#efeeea] bg-[#fafafa] min-[769px]:min-h-[96px]"
                        />
                      );
                    }

                    const key = dateKey(day);
                    const daySessions = sessionsByDate[key] ?? [];
                    const isToday = key === today;
                    const hasPersonal = daySessions.some((item) => joinedIds.has(item.id));
                    const hasGroup = daySessions.some((item) => !joinedIds.has(item.id));

                    return (
                      <div
                        key={key}
                        className="flex min-h-16 flex-col border-b border-r border-[#efeeea] bg-white px-1 py-1 transition-colors hover:bg-[#f7f7f5] min-[769px]:min-h-[96px] min-[769px]:px-2 min-[769px]:py-1.5"
                      >
                        <div
                          className={`mb-1 flex h-[22px] w-[22px] items-center justify-center text-[12.5px] font-semibold ${
                            isToday ? "rounded-full bg-[#18181b] text-white" : "text-[#18181b]"
                          }`}
                        >
                          {day.getDate()}
                        </div>
                        <div className="flex flex-1 flex-col space-y-1">
                          {daySessions.slice(0, 2).map((item) => {
                            const kind = joinedIds.has(item.id) ? "personal" : "group";
                            return (
                              <Link
                                key={item.id}
                                to={`/sessions/${item.id}`}
                                className={`hidden min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium min-[769px]:flex ${
                                  kind === "personal" ? "bg-[#e7f6ec] text-[#16a34a]" : "bg-[#fdecec] text-[#dc2626]"
                                }`}
                              >
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kind === "personal" ? "bg-[#16a34a]" : "bg-[#dc2626]"}`} />
                                <span className="truncate">{item.start_time} {item.venue}</span>
                              </Link>
                            );
                          })}
                          {daySessions.length > 2 && (
                            <div className="hidden px-1.5 text-[10.5px] text-[#71717a] min-[769px]:block">+{daySessions.length - 2} thêm</div>
                          )}
                          {(hasPersonal || hasGroup) && (
                            <div className="mt-auto flex h-2 items-center min-[769px]:hidden">
                              {hasPersonal && hasGroup ? (
                                <span
                                  className="h-1 w-3 rounded-sm"
                                  style={{ background: "linear-gradient(90deg, #16a34a 0 50%, #dc2626 50% 100%)" }}
                                />
                              ) : (
                                <span className={`h-1.5 w-1.5 rounded-full ${hasPersonal ? "bg-[#16a34a]" : "bg-[#dc2626]"}`} />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[604px] min-[769px]:min-w-[840px]">
                <div className="grid grid-cols-[44px_repeat(7,minmax(80px,1fr))] border-b border-[#e8e7e2] min-[769px]:grid-cols-[56px_repeat(7,1fr)]">
                  <div className="border-r border-[#efeeea]" />
                  {weekDays.map((day, index) => {
                    const isToday = dateKey(day) === today;
                    return (
                      <div key={dateKey(day)} className="border-r border-[#efeeea] px-2 py-2 text-center">
                        <div className="text-[11px] font-semibold uppercase tracking-[.5px] text-[#71717a]">{WEEKDAYS[index]}</div>
                        <div className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center text-base font-bold ${isToday ? "rounded-full bg-[#18181b] text-white" : "text-[#18181b]"}`}>
                          {day.getDate()}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="grid max-h-[560px] grid-cols-[44px_repeat(7,minmax(80px,1fr))] overflow-y-auto border-l border-[#efeeea] min-[769px]:grid-cols-[56px_repeat(7,1fr)]">
                  <div className="border-r border-[#e8e7e2]">
                    {HOURS.map((hour) => (
                      <div key={hour} className="h-[60px] border-b border-[#efeeea] px-1.5 py-1 text-right text-[10px] text-[#71717a]">
                        {hour}:00
                      </div>
                    ))}
                  </div>
                  {weekDays.map((day) => {
                    const items = sessionsByDate[dateKey(day)] ?? [];
                    return (
                      <div key={dateKey(day)} className="relative border-r border-[#efeeea]">
                        {HOURS.map((hour) => (
                          <div key={hour} className="h-[60px] border-b border-[#efeeea]" />
                        ))}
                        {items.map((item) => {
                          const kind = joinedIds.has(item.id) ? "personal" : "group";
                          return (
                            <Link
                              key={item.id}
                              to={`/sessions/${item.id}`}
                              style={{ top: `${eventTop(item)}px` }}
                              className={`absolute left-1 right-1 overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-[11px] font-medium leading-[1.3] ${
                                kind === "personal" ? "border-[#16a34a] bg-[#e7f6ec] text-[#16a34a]" : "border-[#dc2626] bg-[#fdecec] text-[#dc2626]"
                              }`}
                            >
                              <div className="truncate font-semibold">{item.venue}</div>
                              <div className="text-[10px] opacity-80">{item.start_time}</div>
                            </Link>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="mt-3.5 flex flex-wrap gap-4 border-t border-[#efeeea] pt-3.5 text-xs text-[#71717a]">
            <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#16a34a]" />Cá nhân</div>
            <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#dc2626]" />Nhóm</div>
            <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border-2 border-[#18181b]" />Hôm nay</div>
          </div>
        </section>

        <div className="flex flex-col gap-[18px]">
          <section>
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#18181b]">
                <User size={16} className="text-[#16a34a]" />
                Buổi của tôi sắp tới
              </div>
              <Link to="/sessions" className="inline-flex items-center gap-1 text-xs font-medium text-[#18181b] hover:underline">
                Xem tất cả <ChevronRight size={13} />
              </Link>
            </div>
            {joinedLoading ? (
              <div className="rounded-xl border border-[#e8e7e2] bg-white p-6 text-center text-sm text-[#71717a]">Đang tải...</div>
            ) : myUpcoming.length === 0 ? (
              <div className="rounded-xl border border-[#e8e7e2] bg-white">
                <EmptyState title="Chưa có buổi nào" description="Bạn chưa đăng ký buổi chơi nào sắp tới" />
              </div>
            ) : (
              <div className="space-y-2">
                {myUpcoming.slice(0, 4).map((item) => (
                  <SessionRow key={item.id} session={item} kind="personal" joined />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#18181b]">
                <Users size={16} className="text-[#dc2626]" />
                Buổi nhóm sắp tới
              </div>
              <Link to="/sessions" className="inline-flex items-center gap-1 text-xs font-medium text-[#18181b] hover:underline">
                Xem tất cả <ChevronRight size={13} />
              </Link>
            </div>
            {groupUpcoming.length === 0 ? (
              <div className="rounded-xl border border-[#e8e7e2] bg-white">
                <EmptyState title="Chưa có buổi chơi nào" description="Tạo buổi mới để bắt đầu" />
              </div>
            ) : (
              <div className="space-y-2">
                {groupUpcoming.map((item) => (
                  <SessionRow key={item.id} session={item} kind="group" joined={joinedIds.has(item.id)} />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[14px] border border-[#e8e7e2] bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#18181b]">
              <Info size={16} className="text-[#71717a]" />
              Tóm tắt nhanh
            </div>
            <div className="space-y-2 text-sm text-[#71717a]">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><Clock size={14} />Buổi sắp tới</span>
                <span className="font-semibold text-[#18181b]">{groupUpcoming.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><CheckCircle2 size={14} />Đã hoàn thành</span>
                <span className="font-semibold text-[#18181b]">{myCompleted.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><DollarSign size={14} />Công nợ</span>
                <span className="font-semibold text-[#18181b]">{formatCurrency(debt)}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
