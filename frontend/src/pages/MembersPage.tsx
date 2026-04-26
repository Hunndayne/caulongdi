import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, MapPin, Phone, ShieldCheck, UserCircle } from "lucide-react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/EmptyState";
import type { UserProfile } from "@/types";

const AVATAR_COLORS = [
  "#f4511e",
  "#5d4037",
  "#16a34a",
  "#2563eb",
  "#c2410c",
  "#7c3aed",
  "#0f766e",
  "#be123c",
];

function colorForProfile(profile: UserProfile) {
  const source = `${profile.id}${profile.email}`;
  const total = [...source].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

export default function MembersPage() {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getProfiles()
      .then(setProfiles)
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được danh sách thành viên"))
      .finally(() => setLoading(false));
  }, []);

  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => a.name.localeCompare(b.name, "vi")),
    [profiles]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UserCircle size={20} className="text-green-600" />
        <h1 className="text-xl font-bold text-gray-900">Hồ sơ trong nhóm</h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : sortedProfiles.length === 0 ? (
        <EmptyState icon="👥" title="Chưa có thành viên" description="Thành viên sẽ xuất hiện sau khi đăng nhập vào app" />
      ) : (
        <div className="space-y-2">
          {sortedProfiles.map((profile) => (
            <Link
              key={profile.id}
              to={`/profiles/${profile.id}`}
              className="flex items-center justify-between gap-3 bg-white rounded-xl border border-gray-100 p-3 shadow-sm hover:border-green-200 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar
                  name={profile.name}
                  color={colorForProfile(profile)}
                  imageUrl={profile.avatarUrl}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-gray-900 truncate">{profile.name}</span>
                    {profile.role === "admin" && (
                      <Badge variant="green" className="hidden sm:inline-flex">
                        <ShieldCheck size={12} className="mr-1" />
                        Admin
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-500 truncate">
                    <Mail size={11} className="flex-shrink-0" />
                    <span className="truncate">{profile.email}</span>
                  </div>
                </div>
              </div>

              <div className="hidden md:flex flex-col items-end gap-1 text-xs text-gray-400">
                {profile.phone && (
                  <span className="flex items-center gap-1">
                    <Phone size={11} />
                    {profile.phone}
                  </span>
                )}
                {profile.location && (
                  <span className="flex items-center gap-1">
                    <MapPin size={11} />
                    {profile.location}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
