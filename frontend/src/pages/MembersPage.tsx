import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Phone } from "lucide-react";
import { useMembersStore } from "@/stores/membersStore";
import { useSession } from "@/lib/auth-client";
import { Avatar } from "@/components/shared/Avatar";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/EmptyState";
import type { Member } from "@/types";

const COLORS = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
];

interface FormState {
  name: string;
  phone: string;
  avatar_color: string;
  is_active: boolean;
}

const defaultForm: FormState = { name: "", phone: "", avatar_color: "#22c55e", is_active: true };

export default function MembersPage() {
  const { data: session } = useSession();
  const { members, loading, fetch, create, update, remove } = useMembersStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [saving, setSaving] = useState(false);
  const isAdmin = (session?.user as any)?.role === "admin";

  useEffect(() => { fetch(); }, []);

  const openCreate = () => { setEditing(null); setForm(defaultForm); setDialogOpen(true); };
  const openEdit = (m: Member) => { setEditing(m); setForm({ name: m.name, phone: m.phone ?? "", avatar_color: m.avatar_color, is_active: !!m.is_active }); setDialogOpen(true); };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await update(editing.id, { name: form.name, phone: form.phone || undefined, avatar_color: form.avatar_color, is_active: form.is_active ? 1 : 0 } as any);
      } else {
        await create({ name: form.name, phone: form.phone || undefined, avatar_color: form.avatar_color });
      }
      setDialogOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Xóa thành viên này?")) return;
    await remove(id);
  };

  const active = members.filter((m) => m.is_active);
  const inactive = members.filter((m) => !m.is_active);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-900">Thành viên</h1>
        {isAdmin && (
          <Button size="sm" onClick={openCreate}>
            <Plus size={16} className="mr-1" />
            Thêm
          </Button>
        )}
      </div>

      {loading && members.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : members.length === 0 ? (
        <EmptyState icon="👥" title="Chưa có thành viên" description="Thêm thành viên đầu tiên" action={isAdmin ? <Button onClick={openCreate}>Thêm thành viên</Button> : undefined} />
      ) : (
        <div className="space-y-4">
          {active.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-gray-500 mb-2">Đang hoạt động ({active.length})</h2>
              <div className="grid grid-cols-1 gap-2">
                {active.map((m) => (
                  <div key={m.id} className="flex items-center justify-between bg-white rounded-xl p-3 border border-gray-100 shadow-sm">
                    <div className="flex items-center gap-3">
                      <Avatar name={m.name} color={m.avatar_color} />
                      <div>
                        <div className="font-medium text-gray-900">{m.name}</div>
                        {m.phone && <div className="text-xs text-gray-500 flex items-center gap-1"><Phone size={11} />{m.phone}</div>}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(m)}><Pencil size={15} /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(m.id)} className="text-red-500 hover:text-red-600"><Trash2 size={15} /></Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {inactive.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-gray-500 mb-2">Không hoạt động ({inactive.length})</h2>
              <div className="grid grid-cols-1 gap-2">
                {inactive.map((m) => (
                  <div key={m.id} className="flex items-center justify-between bg-white rounded-xl p-3 border border-gray-100 shadow-sm opacity-60">
                    <div className="flex items-center gap-3">
                      <Avatar name={m.name} color={m.avatar_color} />
                      <div>
                        <div className="font-medium text-gray-700">{m.name}</div>
                        <Badge variant="gray">Inactive</Badge>
                      </div>
                    </div>
                    {isAdmin && (
                      <Button variant="ghost" size="icon" onClick={() => openEdit(m)}><Pencil size={15} /></Button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={editing ? "Sửa thành viên" : "Thêm thành viên"}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Tên *</label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nguyễn Văn A" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Số điện thoại</label>
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="0912345678" type="tel" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-2">Màu avatar</label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button key={c} onClick={() => setForm((f) => ({ ...f, avatar_color: c }))}
                  className={`w-8 h-8 rounded-full transition-transform ${form.avatar_color === c ? "scale-125 ring-2 ring-offset-1 ring-gray-400" : ""}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} className="rounded" />
              Đang hoạt động
            </label>
          )}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>Hủy</Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving || !form.name.trim()}>
              {saving ? "Đang lưu..." : "Lưu"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
