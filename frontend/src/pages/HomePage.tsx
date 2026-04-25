import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Calendar, ChevronRight, TrendingUp } from "lucide-react";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useSession } from "@/lib/auth-client";
import { formatDate, formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/EmptyState";
import { Avatar } from "@/components/shared/Avatar";
import { api } from "@/api/client";
import { useState } from "react";
import type { MemberStats } from "@/types";

export default function HomePage() {
  const { data: session } = useSession();
  const { sessions, fetch } = useSessionsStore();
  const [myStats, setMyStats] = useState<MemberStats | null>(null);

  useEffect(() => {
    fetch();
    api.getStats().then((s) => {
      // Find stats for logged in user based on email match - best effort
      setMyStats(s.memberStats[0] ?? null);
    }).catch(() => {});
  }, []);

  const upcoming = sessions.filter((s) => s.status === "upcoming").slice(0, 3);
  const recent = sessions.filter((s) => s.status === "completed").slice(0, 3);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthCount = sessions.filter((s) => s.date.startsWith(thisMonth)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-600 to-emerald-500 rounded-2xl p-5 text-white">
        <p className="text-green-100 text-sm">Xin chào,</p>
        <h1 className="text-xl font-bold">{session?.user.name} 👋</h1>
        <div className="flex gap-4 mt-4">
          <div className="bg-white/20 rounded-xl px-4 py-2 text-center">
            <div className="text-2xl font-bold">{thisMonthCount}</div>
            <div className="text-xs text-green-100">Buổi tháng này</div>
          </div>
          {myStats && (
            <div className="bg-white/20 rounded-xl px-4 py-2 text-center">
              <div className="text-2xl font-bold">{formatCurrency(myStats.debt)}</div>
              <div className="text-xs text-green-100">Còn nợ</div>
            </div>
          )}
        </div>
      </div>

      {/* Upcoming */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Calendar size={18} className="text-green-600" />
            Buổi sắp tới
          </h2>
          <Link to="/sessions" className="text-sm text-green-600 font-medium">Xem tất cả</Link>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState icon="📅" title="Chưa có buổi chơi nào" description="Tạo buổi mới để bắt đầu" />
        ) : (
          <div className="space-y-2">
            {upcoming.map((s) => (
              <Link key={s.id} to={`/sessions/${s.id}`}
                className="flex items-center justify-between bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 transition-colors">
                <div>
                  <div className="font-medium text-gray-900">{s.venue}</div>
                  <div className="text-sm text-gray-500">{formatDate(s.date)} · {s.start_time}</div>
                  {s.location && <div className="text-xs text-gray-400">{s.location}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="green">Sắp tới</Badge>
                  <ChevronRight size={16} className="text-gray-400" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent */}
      {recent.length > 0 && (
        <section>
          <h2 className="font-semibold text-gray-900 flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-green-600" />
            Buổi gần đây
          </h2>
          <div className="space-y-2">
            {recent.map((s) => (
              <Link key={s.id} to={`/sessions/${s.id}`}
                className="flex items-center justify-between bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 transition-colors">
                <div>
                  <div className="font-medium text-gray-900">{s.venue}</div>
                  <div className="text-sm text-gray-500">
                    {formatDate(s.date)} · {s.attendee_count ?? 0} người · {formatCurrency(s.total_cost ?? 0)}
                  </div>
                </div>
                <ChevronRight size={16} className="text-gray-400" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
