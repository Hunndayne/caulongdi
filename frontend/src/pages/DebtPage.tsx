import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { formatCurrency } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import { useGroupsStore } from "@/stores/groupsStore";
import type { MemberStats } from "@/types";

export default function DebtPage() {
  const activeGroupId = useGroupsStore((state) => state.activeGroupId);
  const fetchGroups = useGroupsStore((state) => state.fetch);
  const [stats, setStats] = useState<MemberStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    setLoading(true);
    api.getStats(activeGroupId)
      .then((s) => setStats([...s.memberStats].sort((a, b) => b.debt - a.debt)))
      .finally(() => setLoading(false));
  }, [activeGroupId]);

  const totalDebt = stats.reduce((sum, s) => sum + s.debt, 0);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Cong no</h1>
      </div>

      {loading ? (
        <div className="py-12 text-center text-gray-400">Dang tai...</div>
      ) : stats.length === 0 ? (
        <EmptyState icon="💰" title="Chua co du lieu" description="Cong no se hien thi sau khi co buoi choi" />
      ) : (
        <div className="space-y-4">
          {totalDebt > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4">
              <span className="font-medium text-red-700">Tong chua thu</span>
              <span className="text-lg font-bold text-red-800">{formatCurrency(totalDebt)}</span>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="p-3 text-left font-medium text-gray-600">Thanh vien</th>
                  <th className="p-3 text-right font-medium text-gray-600">Da tra</th>
                  <th className="p-3 text-right font-medium text-gray-600">Con no</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s, i) => (
                  <tr key={s.memberId} className={`border-b border-gray-50 ${i % 2 === 0 ? "" : "bg-gray-50/50"}`}>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={s.memberName} color={s.avatarColor} size="sm" />
                        <div>
                          <div className="font-medium text-gray-900">{s.memberName}</div>
                          <div className="text-xs text-gray-400">{s.attendCount} buoi</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-right font-medium text-green-700">{formatCurrency(s.totalPaid)}</td>
                    <td className="p-3 text-right">
                      <span className={`font-semibold ${s.debt > 0 ? "text-red-600" : "text-gray-400"}`}>
                        {s.debt > 0 ? formatCurrency(s.debt) : "Du"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
