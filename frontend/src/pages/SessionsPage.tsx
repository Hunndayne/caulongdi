import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ChevronRight, MapPin, Clock, Users } from "lucide-react";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/permissions";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatDate, formatDateLong, formatCurrency } from "@/lib/utils";
import type { Session } from "@/types";

interface FormState {
  date: string;
  startTime: string;
  venue: string;
  location: string;
  note: string;
}

const defaultForm: FormState = {
  date: new Date().toISOString().slice(0, 10),
  startTime: "08:00",
  venue: "",
  location: "",
  note: "",
};

export default function SessionsPage() {
  const { data: session } = useSession();
  const { sessions, loading, fetch, create } = useSessionsStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [saving, setSaving] = useState(false);
  const isAdmin = isAdminUser(session?.user);

  useEffect(() => { fetch(); }, []);

  const handleCreate = async () => {
    if (!form.venue.trim()) return;
    setSaving(true);
    try {
      await create({ date: form.date, start_time: form.startTime, venue: form.venue, location: form.location || undefined, note: form.note || undefined } as any);
      setDialogOpen(false);
      setForm(defaultForm);
    } finally {
      setSaving(false);
    }
  };

  // Group by month
  const grouped = sessions.reduce<Record<string, Session[]>>((acc, s) => {
    const month = s.date.slice(0, 7);
    (acc[month] = acc[month] ?? []).push(s);
    return acc;
  }, {});

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-900">Buổi chơi</h1>
        {isAdmin && (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus size={16} className="mr-1" />
            Tạo buổi
          </Button>
        )}
      </div>

      {loading && sessions.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : sessions.length === 0 ? (
        <EmptyState icon="🏸" title="Chưa có buổi chơi nào" action={isAdmin ? <Button onClick={() => setDialogOpen(true)}>Tạo buổi đầu tiên</Button> : undefined} />
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([month, items]) => {
            const [y, m] = month.split("-");
            return (
              <section key={month}>
                <h2 className="text-sm font-semibold text-gray-500 mb-2">Tháng {m}/{y} ({items.length} buổi)</h2>
                <div className="space-y-2">
                  {items.map((s) => (
                    <Link key={s.id} to={`/sessions/${s.id}`}
                      className="flex items-center justify-between bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:border-green-200 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium text-gray-900 truncate">{s.venue}</span>
                          <Badge variant={s.status === "upcoming" ? "green" : "gray"}>
                            {s.status === "upcoming" ? "Sắp tới" : "Hoàn thành"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                          <span className="flex items-center gap-1"><Clock size={11} />{formatDate(s.date)} · {s.start_time}</span>
                          {s.location && <span className="flex items-center gap-1 truncate"><MapPin size={11} />{s.location}</span>}
                          {s.attendee_count != null && <span className="flex items-center gap-1"><Users size={11} />{s.attendee_count} người</span>}
                          {s.total_cost ? <span>{formatCurrency(s.total_cost)}</span> : null}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-gray-400 flex-shrink-0 ml-2" />
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Tạo buổi chơi mới">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Ngày *</label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Giờ *</label>
              <Input type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Tên sân *</label>
            <Input value={form.venue} onChange={(e) => setForm((f) => ({ ...f, venue: e.target.value }))} placeholder="Sân cầu lông ABC" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Địa chỉ</label>
            <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="123 Nguyễn Trãi, Q1" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Ghi chú</label>
            <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Mang vợt riêng..." />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>Hủy</Button>
            <Button className="flex-1" onClick={handleCreate} disabled={saving || !form.venue.trim()}>
              {saving ? "Đang tạo..." : "Tạo buổi"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
