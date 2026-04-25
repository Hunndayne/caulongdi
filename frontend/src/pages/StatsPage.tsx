import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { formatCurrency } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import type { StatsResponse } from "@/types";

export default function StatsPage() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getStats().then(setData).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-12 text-gray-400">Đang tải...</div>;
  if (!data) return null;

  const chartData = [...(data.monthlyStats ?? [])].reverse().map((m) => ({
    month: m.month.slice(5) + "/" + m.month.slice(2, 4),
    "Số buổi": m.session_count,
  }));

  const top5 = [...data.memberStats].sort((a, b) => b.attendCount - a.attendCount).slice(0, 5);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">Thống kê</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <div className="text-3xl font-bold text-green-600">{data.totalSessions}</div>
          <div className="text-sm text-gray-500 mt-1">Tổng buổi chơi</div>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <div className="text-3xl font-bold text-green-600">{data.memberStats.length}</div>
          <div className="text-sm text-gray-500 mt-1">Thành viên</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
          <h2 className="font-semibold text-gray-900 mb-4">Số buổi theo tháng</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 12, fill: "#6b7280" }} allowDecimals={false} />
              <Tooltip formatter={(val: number) => [val, "Buổi"]} />
              <Bar dataKey="Số buổi" fill="#16a34a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {top5.length === 0 ? (
        <EmptyState icon="📊" title="Chưa có dữ liệu thống kê" />
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Tham gia nhiều nhất</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {top5.map((m, i) => (
              <div key={m.memberId} className="flex items-center gap-3 p-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${i === 0 ? "bg-yellow-100 text-yellow-700" : i === 1 ? "bg-gray-100 text-gray-600" : i === 2 ? "bg-orange-100 text-orange-600" : "bg-gray-50 text-gray-400"}`}>
                  {i + 1}
                </span>
                <Avatar name={m.memberName} color={m.avatarColor} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{m.memberName}</div>
                  <div className="text-xs text-gray-500">{m.attendCount} buổi tham gia</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-gray-900">{formatCurrency(m.totalPaid)}</div>
                  {m.debt > 0 && <div className="text-xs text-red-500">-{formatCurrency(m.debt)}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
