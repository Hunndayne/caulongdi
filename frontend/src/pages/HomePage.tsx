import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Calendar,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  TrendingUp,
  User,
} from "lucide-react";
import { api } from "@/api/client";
import { useSession } from "@/lib/auth-client";
import { useSessionsStore } from "@/stores/sessionsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";
import { GroupSelector } from "@/components/shared/GroupSelector";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { MemberStats, Session } from "@/types";

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

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
    "PRODID:-//Hoi Cau Long//Session Calendar//VI",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${session.id}@caulong.hunn.io.vn`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcs(`Cầu lông - ${session.venue}`)}`,
    `LOCATION:${escapeIcs(location)}`,
    `DESCRIPTION:${escapeIcs(session.note || "Buổi chơi Hội cầu lông")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeVenue = session.venue.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  link.href = url;
  link.download = `${session.date}-${safeVenue || "cau-long"}.ics`;
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

type CalendarMode = "group" | "mine";

export default function HomePage() {
  const { data: session } = useSession();
  const { sessions, fetch } = useSessionsStore();
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [myStats, setMyStats] = useState<MemberStats | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("mine");
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

  const upcoming = useMemo(
    () => sessions.filter((s) => s.status === "upcoming").sort(compareSessionAsc).slice(0, 3),
    [sessions]
  );
  const recent = useMemo(
    () => sessions.filter((s) => s.status === "completed").sort(compareSessionDesc).slice(0, 3),
    [sessions]
  );

  // Sessions hiển thị trên lịch tuỳ theo mode
  const calendarSessions = calendarMode === "mine" ? joinedSessions : sessions;

  const thisMonth = monthKey(new Date());
  const myThisMonthCount = joinedSessions.filter((s) => s.date.startsWith(thisMonth)).length;
  const activeMonth = monthKey(calendarMonth);
  const monthSessions = calendarSessions.filter((s) => s.date.startsWith(activeMonth));
  const upcomingInMonth = monthSessions.filter((s) => s.status === "upcoming").length;
  const today = dateKey(new Date());

  const sessionsByDate = useMemo(() => {
    return calendarSessions.reduce<Record<string, Session[]>>((acc, item) => {
      acc[item.date] = [...(acc[item.date] ?? []), item].sort(compareSessionAsc);
      return acc;
    }, {});
  }, [calendarSessions]);

  const monthCells = useMemo(() => buildMonthCells(calendarMonth), [calendarMonth]);

  const changeMonth = (amount: number) => {
    setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  // Các buổi sắp tới mà mình đã đăng ký
  const myUpcoming = useMemo(
    () => joinedSessions.filter((s) => s.status === "upcoming").sort(compareSessionAsc),
    [joinedSessions]
  );

  // Các buổi đã qua mà mình đã tham gia
  const myCompleted = useMemo(
    () => joinedSessions.filter((s) => s.status === "completed").sort(compareSessionDesc),
    [joinedSessions]
  );

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-green-600 to-emerald-500 rounded-2xl p-5 text-white">
        <p className="text-green-100 text-sm">Xin chào,</p>
        <h1 className="text-xl font-bold">{session?.user.name} 👋</h1>
        <div className="flex gap-4 mt-4">
          <div className="bg-white/20 rounded-xl px-4 py-2 text-center">
            <div className="text-2xl font-bold">{myThisMonthCount}</div>
            <div className="text-xs text-green-100">Buổi tháng này</div>
          </div>
          <div className="bg-white/20 rounded-xl px-4 py-2 text-center">
            <div className="text-2xl font-bold">{joinedSessions.length}</div>
            <div className="text-xs text-green-100">Tổng buổi đã tham gia</div>
          </div>
          {myStats && (
            <div className="bg-white/20 rounded-xl px-4 py-2 text-center">
              <div className="text-2xl font-bold">{formatCurrency(myStats.debt)}</div>
              <div className="text-xs text-green-100">Còn nợ</div>
            </div>
          )}
        </div>
      </div>

      <GroupSelector value={selectedGroupId} onChange={setSelectedGroupId} allowAll allLabel="Tong hop tat ca nhom" />

      {/* Lịch */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Calendar size={18} className="text-green-600" />
            Lịch tháng
          </h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => changeMonth(-1)} aria-label="Tháng trước">
              <ChevronLeft size={17} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => changeMonth(1)} aria-label="Tháng sau">
              <ChevronRight size={17} />
            </Button>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-semibold text-gray-900 capitalize">{monthTitle(calendarMonth)}</div>
              <div className="text-xs text-gray-500">
                {monthSessions.length} buổi · {upcomingInMonth} sắp tới
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Toggle nhóm / của tôi */}
              <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 text-xs">
                <button
                  onClick={() => setCalendarMode("mine")}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    calendarMode === "mine"
                      ? "bg-white text-green-700 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Của tôi
                </button>
                <button
                  onClick={() => setCalendarMode("group")}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    calendarMode === "group"
                      ? "bg-white text-green-700 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Nhóm
                </button>
              </div>
              <Button variant="outline" size="sm" onClick={() => setCalendarMonth(new Date())}>
                Hôm nay
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-gray-400 mb-1">
            {WEEKDAYS.map((day) => (
              <div key={day} className="py-1">
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {monthCells.map((day, index) => {
              if (!day) {
                return <div key={`empty-${index}`} className="min-h-14 rounded-lg bg-gray-50/60" />;
              }

              const key = dateKey(day);
              const daySessions = sessionsByDate[key] ?? [];
              const isToday = key === today;

              return (
                <div
                  key={key}
                  className={`min-h-14 rounded-lg border px-1.5 py-1.5 ${
                    isToday ? "border-green-500 bg-green-50" : "border-gray-100 bg-gray-50/70"
                  }`}
                >
                  <div className={`text-xs font-semibold ${isToday ? "text-green-700" : "text-gray-700"}`}>
                    {day.getDate()}
                  </div>
                  <div className="mt-1 flex flex-col gap-1">
                    {daySessions.slice(0, 2).map((item) => (
                      <Link
                        key={item.id}
                        to={`/sessions/${item.id}`}
                        aria-label={`${item.venue} ${formatDate(item.date)}`}
                        className={`h-1.5 rounded-full ${
                          item.status === "upcoming" ? "bg-green-500" : "bg-gray-300"
                        }`}
                      />
                    ))}
                    {daySessions.length > 2 && (
                      <span className="text-[10px] leading-none text-gray-400">+{daySessions.length - 2}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Buổi của tôi sắp tới */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <User size={18} className="text-green-600" />
            Buổi của tôi sắp tới
          </h2>
          <Link to="/sessions" className="text-sm text-green-600 font-medium">
            Xem tất cả
          </Link>
        </div>
        {joinedLoading ? (
          <div className="text-center py-6 text-gray-400 text-sm">Đang tải...</div>
        ) : myUpcoming.length === 0 ? (
          <EmptyState icon="📅" title="Chưa có buổi nào" description="Bạn chưa đăng ký buổi chơi nào sắp tới" />
        ) : (
          <div className="space-y-2">
            {myUpcoming.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 transition-colors"
              >
                <Link to={`/sessions/${item.id}`} className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900 truncate">{item.venue}</div>
                  <div className="text-sm text-gray-500">
                    {formatDate(item.date)} · {item.start_time}
                  </div>
                  {item.location && (
                    <div className="text-xs text-gray-400 flex items-center gap-1 truncate">
                      <MapPin size={11} />
                      {item.location}
                    </div>
                  )}
                </Link>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge variant="green">Sắp tới</Badge>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => downloadCalendarFile(item)}
                    aria-label="Thêm vào lịch"
                    title="Thêm vào lịch"
                  >
                    <CalendarPlus size={16} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Buổi nhóm sắp tới (ngoài buổi của mình) */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Clock size={18} className="text-green-600" />
            Buổi nhóm sắp tới
          </h2>
          <Link to="/sessions" className="text-sm text-green-600 font-medium">
            Xem tất cả
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState icon="📅" title="Chưa có buổi chơi nào" description="Tạo buổi mới để bắt đầu" />
        ) : (
          <div className="space-y-2">
            {upcoming.map((item) => {
              const iJoined = joinedSessions.some((j) => j.id === item.id);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 transition-colors"
                >
                  <Link to={`/sessions/${item.id}`} className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">{item.venue}</div>
                    <div className="text-sm text-gray-500">
                      {formatDate(item.date)} · {item.start_time}
                    </div>
                    {item.location && (
                      <div className="text-xs text-gray-400 flex items-center gap-1 truncate">
                        <MapPin size={11} />
                        {item.location}
                      </div>
                    )}
                  </Link>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {iJoined ? (
                      <Badge variant="green">Đã đăng ký</Badge>
                    ) : (
                      <Badge variant="gray">Chưa đăng ký</Badge>
                    )}
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => downloadCalendarFile(item)}
                      aria-label="Thêm vào lịch"
                      title="Thêm vào lịch"
                    >
                      <CalendarPlus size={16} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {myCompleted.length > 0 && (
        <section>
          <h2 className="font-semibold text-gray-900 flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-green-600" />
            Buổi tôi đã tham gia gần đây
          </h2>
          <div className="space-y-2">
            {myCompleted.slice(0, 5).map((item) => (
              <Link
                key={item.id}
                to={`/sessions/${item.id}`}
                className="flex items-center justify-between bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 transition-colors"
              >
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{item.venue}</div>
                  <div className="text-sm text-gray-500">
                    {formatDate(item.date)} · {item.attendee_count ?? 0} người · {formatCurrency(item.total_cost ?? 0)}
                  </div>
                </div>
                <ChevronRight size={16} className="text-gray-400 flex-shrink-0 ml-2" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
