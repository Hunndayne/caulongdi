import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { GroupSelector } from "@/components/shared/GroupSelector";
import { formatCurrency } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import type { MemberStats } from "@/types";

export default function DebtPage() {
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [stats, setStats] = useState<MemberStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getStats(selectedGroupId)
      .then((s) => setStats([...s.memberStats].sort((a, b) => b.debt - a.debt)))
      .finally(() => setLoading(false));
  }, [selectedGroupId]);

  const totalDebt = stats.reduce((sum, s) => sum + s.debt, 0);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Công nợ</h1>
      </div>

      <div className="mb-5">
        <GroupSelector value={selectedGroupId} onChange={setSelectedGroupId} allowAll allLabel="Tổng hợp tất cả nhóm" />
      </div>

      {loading ? (
        <div className="py-12 text-center text-gray-400">Đang tải...</div>
      ) : stats.length === 0 ? (
        <EmptyState icon="💰" title="Chưa có dữ liệu" description="Công nợ sẽ hiển thị sau khi có buổi chơi" />
      ) : (
        <div className="space-y-4">
          {totalDebt > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4">
              <span className="font-medium text-red-700">Tổng chưa thu</span>
              <span className="text-lg font-bold text-red-800">{formatCurrency(totalDebt)}</span>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="p-3 text-left font-medium text-gray-600">Thành viên</th>
                  <th className="p-3 text-right font-medium text-gray-600">Đã trả</th>
                  <th className="p-3 text-right font-medium text-gray-600">Còn nợ</th>
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
                          <div className="text-xs text-gray-400">{s.attendCount} buổi</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-right font-medium text-green-700">{formatCurrency(s.totalPaid)}</td>
                    <td className="p-3 text-right">
                      <span className={`font-semibold ${s.debt > 0 ? "text-red-600" : "text-gray-400"}`}>
                        {s.debt > 0 ? formatCurrency(s.debt) : "Đủ"}
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
