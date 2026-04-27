import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Users } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useGroupsStore } from "@/stores/groupsStore";
import type { JoinLinkPreview } from "@/types";

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const fetchGroups = useGroupsStore((s) => s.fetch);
  const setActiveGroup = useGroupsStore((s) => s.setActiveGroup);

  const [preview, setPreview] = useState<JoinLinkPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    api
      .getJoinLinkPreview(code)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : "Link không hợp lệ hoặc đã hết hạn"))
      .finally(() => setLoading(false));
  }, [code]);

  const handleJoin = async () => {
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api.joinViaLink(code);
      await fetchGroups();
      setActiveGroup(result.groupId);
      navigate("/members", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tham gia được nhóm");
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-3">🏸</div>
          <div className="text-gray-500 text-sm">Đang tải...</div>
        </div>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <div className="text-5xl">😢</div>
          <h1 className="text-xl font-bold text-gray-900">Không tìm thấy lời mời</h1>
          <p className="text-sm text-gray-500">{error || "Link mời không hợp lệ hoặc đã hết hạn."}</p>
          <Button variant="outline" onClick={() => navigate("/members", { replace: true })}>
            Quay về trang thành viên
          </Button>
        </div>
      </div>
    );
  }

  if (preview.alreadyMember) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <div className="text-5xl">✅</div>
          <h1 className="text-xl font-bold text-gray-900">Bạn đã ở trong nhóm</h1>
          <p className="text-sm text-gray-500">
            Bạn đã là thành viên của <span className="font-semibold">{preview.groupName}</span>.
          </p>
          <Button onClick={() => { setActiveGroup(preview.groupId); navigate("/members", { replace: true }); }}>
            Đi đến nhóm
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-lg text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
          <Users size={32} className="text-green-600" />
        </div>

        <div>
          <h1 className="text-xl font-bold text-gray-900">Bạn được mời vào nhóm</h1>
          <p className="mt-2 text-2xl font-bold text-green-700">{preview.groupName}</p>
          {preview.groupDescription && (
            <p className="mt-1 text-sm text-gray-500">{preview.groupDescription}</p>
          )}
        </div>

        <div className="text-sm text-gray-500">
          {preview.memberCount} thành viên
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <Button className="w-full text-base py-3" onClick={handleJoin} disabled={joining}>
          {joining ? "Đang tham gia..." : "Tham gia nhóm"}
        </Button>
      </div>
    </div>
  );
}
