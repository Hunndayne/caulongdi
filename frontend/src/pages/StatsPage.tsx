import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { formatCurrency } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import { useGroupsStore } from "@/stores/groupsStore";
import type { StatsResponse } from "@/types";

export default function StatsPage() {
  const activeGroupId = useGroupsStore((state) => state.activeGroupId);
  const fetchGroups = useGroupsStore((state) => state.fetch);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    setLoading(true);
    api.getStats(activeGroupId).then(setData).finally(() => setLoading(false));
  }, [activeGroupId]);

  if (loading) return <div className="py-12 text-center text-gray-400">Dang tai...</div>;
  if (!data) return null;

  const chartData = [...(data.monthlyStats ?? [])].reverse().map((m) => ({
    month: m.month.slice(5) + "/" + m.month.slice(2, 4),
    "So buoi": m.session_count,
  }));

  const top5 = [...data.memberStats].sort((a, b) => b.attendCount - a.attendCount).slice(0, 5);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">Thong ke</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-gray-100 bg-white p-4 text-center shadow-sm">
          <div className="text-3xl font-bold text-green-600">{data.totalSessions}</div>
          <div className="mt-1 text-sm text-gray-500">Tong buoi choi</div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 text-center shadow-sm">
          <div className="text-3xl font-bold text-green-600">{data.memberStats.length}</div>
          <div className="mt-1 text-sm text-gray-500">Thanh vien</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <h2 className="mb-4 font-semibold text-gray-900">So buoi theo thang</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 12, fill: "#6b7280" }} allowDecimals={false} />
              <Tooltip formatter={(val: number) => [val, "Buoi"]} />
              <Bar dataKey="So buoi" fill="#16a34a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {top5.length === 0 ? (
        <EmptyState icon="📊" title="Chua co du lieu thong ke" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-4">
            <h2 className="font-semibold text-gray-900">Tham gia nhieu nhat</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {top5.map((m, i) => (
              <div key={m.memberId} className="flex items-center gap-3 p-3">
                <span
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    i === 0
                      ? "bg-yellow-100 text-yellow-700"
                      : i === 1
                        ? "bg-gray-100 text-gray-600"
                        : i === 2
                          ? "bg-orange-100 text-orange-600"
                          : "bg-gray-50 text-gray-400"
                  }`}
                >
                  {i + 1}
                </span>
                <Avatar name={m.memberName} color={m.avatarColor} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-gray-900">{m.memberName}</div>
                  <div className="text-xs text-gray-500">{m.attendCount} buoi tham gia</div>
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
