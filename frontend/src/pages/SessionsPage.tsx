import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ChevronRight, MapPin, Clock, Users } from "lucide-react";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useGroupsStore } from "@/stores/groupsStore";
import { GroupSelector } from "@/components/shared/GroupSelector";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatDate, formatCurrency } from "@/lib/utils";
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
  const { sessions, loading, fetch, create } = useSessionsStore();
  const activeGroupId = useGroupsStore((state) => state.activeGroupId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(activeGroupId);
  }, [activeGroupId, fetch]);

  const handleCreate = async () => {
    if (!form.venue.trim()) return;
    setSaving(true);
    try {
      await create({
        date: form.date,
        startTime: form.startTime,
        venue: form.venue,
        location: form.location || undefined,
        note: form.note || undefined,
        groupId: activeGroupId,
      } as any);
      setDialogOpen(false);
      setForm(defaultForm);
    } finally {
      setSaving(false);
    }
  };

  const grouped = sessions.reduce<Record<string, Session[]>>((acc, session) => {
    const month = session.date.slice(0, 7);
    (acc[month] = acc[month] ?? []).push(session);
    return acc;
  }, {});

  return (
    <div>
      <GroupSelector />

      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-900">Buổi chơi</h1>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus size={16} className="mr-1" />
          Tạo buổi
        </Button>
      </div>

      {loading && sessions.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon="🏸"
          title="Chưa có buổi chơi nào"
          action={<Button onClick={() => setDialogOpen(true)}>Tạo buổi đầu tiên</Button>}
        />
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([month, items]) => {
            const [year, monthNumber] = month.split("-");
            return (
              <section key={month}>
                <h2 className="text-sm font-semibold text-gray-500 mb-2">
                  Tháng {monthNumber}/{year} ({items.length} buổi)
                </h2>
                <div className="space-y-2">
                  {items.map((session) => (
                    <Link
                      key={session.id}
                      to={`/sessions/${session.id}`}
                      className="flex items-center justify-between bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:border-green-200 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium text-gray-900 truncate">{session.venue}</span>
                          <Badge variant={session.status === "upcoming" ? "green" : "gray"}>
                            {session.status === "upcoming" ? "Sắp tới" : "Hoàn thành"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                          <span className="flex items-center gap-1">
                            <Clock size={11} />
                            {formatDate(session.date)} · {session.start_time}
                          </span>
                          {session.location && (
                            <span className="flex items-center gap-1 truncate">
                              <MapPin size={11} />
                              {session.location}
                            </span>
                          )}
                          {session.attendee_count != null && (
                            <span className="flex items-center gap-1">
                              <Users size={11} />
                              {session.attendee_count} người
                            </span>
                          )}
                          {session.total_cost ? <span>{formatCurrency(session.total_cost)}</span> : null}
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
              <Input type="date" value={form.date} onChange={(e) => setForm((current) => ({ ...current, date: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Giờ *</label>
              <Input type="time" value={form.startTime} onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Tên sân *</label>
            <Input value={form.venue} onChange={(e) => setForm((current) => ({ ...current, venue: e.target.value }))} placeholder="Sân cầu lông ABC" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Địa chỉ</label>
            <Input value={form.location} onChange={(e) => setForm((current) => ({ ...current, location: e.target.value }))} placeholder="123 Nguyễn Trãi, Q1" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Ghi chú</label>
            <Input value={form.note} onChange={(e) => setForm((current) => ({ ...current, note: e.target.value }))} placeholder="Mang vợt riêng..." />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button className="flex-1" onClick={handleCreate} disabled={saving || !form.venue.trim()}>
              {saving ? "Đang tạo..." : "Tạo buổi"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
