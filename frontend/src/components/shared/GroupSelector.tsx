import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Settings2, Users } from "lucide-react";
import { useGroupsStore } from "@/stores/groupsStore";

export function GroupSelector() {
  const { groups, activeGroupId, loading, error, fetch, setActiveGroup } = useGroupsStore();

  useEffect(() => {
    fetch();
  }, [fetch]);

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
            <option value="">Chua co nhom</option>
          ) : (
            groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))
          )}
        </select>
        <Link
          to="/members"
          aria-label="Quan ly nhom"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white p-2 text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
        >
          <Settings2 size={16} />
        </Link>
      </div>
      {(error || groups.length === 0) && (
        <div className="mt-2 text-xs text-gray-500">
          {error ?? "Quan ly nhom va loi moi o trang Thanh vien."}
        </div>
      )}
    </div>
  );
}
