import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Settings2, Users } from "lucide-react";
import { useGroupsStore } from "@/stores/groupsStore";

type GroupSelectorProps = {
  value?: string;
  onChange?: (id?: string) => void;
  allowAll?: boolean;
  allLabel?: string;
};

export function GroupSelector({
  value,
  onChange,
  allowAll = false,
  allLabel = "Tất cả nhóm",
}: GroupSelectorProps) {
  const { groups, activeGroupId, loading, error, fetch, setActiveGroup } = useGroupsStore();
  const isControlled = typeof onChange === "function";
  const selectedValue = isControlled ? value ?? "" : activeGroupId ?? "";

  useEffect(() => {
    fetch();
  }, [fetch]);

  return (
    <div className="mb-[18px] max-w-[460px] rounded-xl border border-[#e8e7e2] bg-white px-3.5 py-1.5">
      <div className="flex items-center gap-2">
        <Users size={16} className="shrink-0 text-[#71717a]" />
        <select
          value={selectedValue}
          onChange={(event) => {
            const nextValue = event.target.value || undefined;
            if (isControlled) onChange?.(nextValue);
            else setActiveGroup(nextValue);
          }}
          disabled={loading || groups.length === 0}
          className="min-w-0 flex-1 border-none bg-transparent py-2 text-[13.5px] font-medium text-[#18181b] outline-none focus:ring-0 disabled:text-[#a1a1aa]"
        >
          {groups.length === 0 ? (
            <option value="">Chưa có nhóm</option>
          ) : (
            <>
              {allowAll && <option value="">{allLabel}</option>}
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </>
          )}
        </select>
        <Link
          to="/members"
          aria-label="Quản lý nhóm"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e8e7e2] bg-white text-[#3f3f46] transition-colors hover:bg-[#f7f7f5] focus:outline-none focus:ring-2 focus:ring-[#18181b]/10"
        >
          <Settings2 size={14} />
        </Link>
      </div>
      {(error || groups.length === 0) && (
        <div className="px-6 pb-2 text-xs text-[#71717a]">
          {error ?? "Quản lý nhóm và lời mời ở trang Thành viên."}
        </div>
      )}
    </div>
  );
}
