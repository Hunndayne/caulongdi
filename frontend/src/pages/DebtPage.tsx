import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { formatCurrency } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import type { MemberStats } from "@/types";

export default function DebtPage() {
  const [stats, setStats] = useState<MemberStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getStats()
      .then((s) => setStats([...s.memberStats].sort((a, b) => b.debt - a.debt)))
      .finally(() => setLoading(false));
  }, []);

  const totalDebt = stats.reduce((sum, s) => sum + s.debt, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-900">Công nợ</h1>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : stats.length === 0 ? (
        <EmptyState icon="💰" title="Chưa có dữ liệu" description="Công nợ sẽ hiển thị sau khi có buổi chơi" />
      ) : (
        <div className="space-y-4">
          {totalDebt > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex justify-between items-center">
              <span className="text-red-700 font-medium">Tổng chưa thu</span>
              <span className="text-red-800 font-bold text-lg">{formatCurrency(totalDebt)}</span>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left p-3 font-medium text-gray-600">Thành viên</th>
                  <th className="text-right p-3 font-medium text-gray-600">Đã trả</th>
                  <th className="text-right p-3 font-medium text-gray-600">Còn nợ</th>
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
                    <td className="p-3 text-right text-green-700 font-medium">{formatCurrency(s.totalPaid)}</td>
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
