import { useEffect, useState } from "react";
import { Plus, Users } from "lucide-react";
import { useGroupsStore } from "@/stores/groupsStore";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function GroupSelector() {
  const { groups, activeGroupId, loading, error, fetch, createGroup, setActiveGroup } = useGroupsStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await createGroup({ name: name.trim(), description: description.trim() || undefined });
      setName("");
      setDescription("");
      setDialogOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Không tạo được nhóm");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-green-600" />
        <select
          value={activeGroupId ?? ""}
          onChange={(event) => setActiveGroup(event.target.value || undefined)}
          disabled={loading || groups.length === 0}
          className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          {groups.length === 0 ? (
            <option value="">Tất cả nhóm</option>
          ) : (
            groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))
          )}
        </select>
        <Button variant="outline" size="icon" onClick={() => setDialogOpen(true)} aria-label="Tạo nhóm">
          <Plus size={16} />
        </Button>
      </div>
      {(error || groups.length === 0) && (
        <div className="mt-2 text-xs text-gray-500">
          {error ?? "Tạo nhóm chơi để tách lịch theo từng nhóm."}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Tạo nhóm chơi">
        <div className="space-y-4">
          {formError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Tên nhóm *</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nhóm cầu lông cuối tuần" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Mô tả</label>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Sân quen, khu vực, lịch chơi..." />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button className="flex-1" onClick={handleCreate} disabled={saving || !name.trim()}>
              {saving ? "Đang tạo..." : "Tạo nhóm"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
