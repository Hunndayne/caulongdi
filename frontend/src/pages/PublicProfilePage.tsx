import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, Mail, MapPin, Phone, UserCircle } from "lucide-react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/ui/badge";
import type { UserProfile } from "@/types";

export default function PublicProfilePage() {
  const { id } = useParams();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getProfile(id)
      .then(setProfile)
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được hồ sơ"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Đang tải...</div>;
  }

  if (error || !profile) {
    return (
      <div className="space-y-4">
        <Link to="/profile" className="inline-flex items-center gap-2 text-sm text-green-700 font-medium">
          <ArrowLeft size={16} />
          Quay lại
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error ?? "Không tìm thấy hồ sơ"}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link to="/profile" className="inline-flex items-center gap-2 text-sm text-green-700 font-medium">
        <ArrowLeft size={16} />
        Hồ sơ trong nhóm
      </Link>

      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-start gap-4">
          <Avatar name={profile.name} color="#16a34a" size="lg" imageUrl={profile.avatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{profile.name}</h1>
              {profile.role === "admin" && <Badge variant="green">Admin</Badge>}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-sm text-gray-500 break-all">
              <Mail size={14} />
              {profile.email}
            </div>
          </div>
        </div>

        {profile.bio && (
          <div className="mt-5 rounded-lg bg-gray-50 p-4 text-sm leading-6 text-gray-700 whitespace-pre-wrap">
            {profile.bio}
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-3 text-sm">
          {profile.phone && (
            <div className="flex items-center gap-2 text-gray-700">
              <Phone size={16} className="text-green-600" />
              {profile.phone}
            </div>
          )}
          {profile.birthday && (
            <div className="flex items-center gap-2 text-gray-700">
              <CalendarDays size={16} className="text-green-600" />
              {profile.birthday}
            </div>
          )}
          {profile.location && (
            <div className="flex items-center gap-2 text-gray-700">
              <MapPin size={16} className="text-green-600" />
              {profile.location}
            </div>
          )}
          {!profile.phone && !profile.birthday && !profile.location && !profile.bio && (
            <div className="flex items-center gap-2 text-gray-500">
              <UserCircle size={16} />
              Thành viên này chưa bổ sung thông tin cá nhân.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
