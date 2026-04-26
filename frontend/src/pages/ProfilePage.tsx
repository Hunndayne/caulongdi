import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, MapPin, Phone, Save, UserCircle } from "lucide-react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signOut } from "@/lib/auth-client";
import type { ProfileUpdateInput, UserProfile } from "@/types";

const emptyForm: Required<ProfileUpdateInput> = {
  name: "",
  phone: "",
  bio: "",
  birthday: "",
  location: "",
  avatarUrl: "",
};

function profileToForm(profile: UserProfile): Required<ProfileUpdateInput> {
  return {
    name: profile.name ?? "",
    phone: profile.phone ?? "",
    bio: profile.bio ?? "",
    birthday: profile.birthday ?? "",
    location: profile.location ?? "",
    avatarUrl: profile.avatarUrl ?? "",
  };
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getMyProfile(), api.getProfiles()])
      .then(([me, all]) => {
        setProfile(me);
        setProfiles(all);
        setForm(profileToForm(me));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được hồ sơ"))
      .finally(() => setLoading(false));
  }, []);

  const updateForm = (key: keyof ProfileUpdateInput, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage(null);
    setError(null);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError("Tên hiển thị là bắt buộc");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateMyProfile(form);
      setProfile(updated);
      setForm(profileToForm(updated));
      setProfiles((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setMessage("Đã lưu hồ sơ");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được hồ sơ");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } finally {
      navigate("/login", { replace: true });
    }
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Đang tải...</div>;
  }

  const otherProfiles = profiles.filter((item) => item.id !== profile?.id);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Hồ sơ</h1>
        <Button variant="outline" size="sm" onClick={handleLogout}>
          <LogOut size={16} className="mr-1.5" />
          Đăng xuất
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {message}
        </div>
      )}

      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Avatar name={form.name || "Bạn"} color="#16a34a" size="lg" imageUrl={form.avatarUrl || undefined} />
          <div className="min-w-0">
            <div className="font-semibold text-gray-900 truncate">{form.name || "Hồ sơ của bạn"}</div>
            <div className="text-sm text-gray-500 truncate">{profile?.email}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Tên hiển thị *</label>
            <Input value={form.name} onChange={(e) => updateForm("name", e.target.value)} placeholder="Tên của bạn" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Số điện thoại</label>
            <Input value={form.phone} onChange={(e) => updateForm("phone", e.target.value)} placeholder="0912345678" type="tel" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Ngày sinh</label>
            <Input value={form.birthday} onChange={(e) => updateForm("birthday", e.target.value)} type="date" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Khu vực</label>
            <Input value={form.location} onChange={(e) => updateForm("location", e.target.value)} placeholder="Quận / thành phố" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Ảnh đại diện URL</label>
            <Input value={form.avatarUrl} onChange={(e) => updateForm("avatarUrl", e.target.value)} placeholder="https://..." />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Giới thiệu</label>
            <textarea
              value={form.bio}
              onChange={(e) => updateForm("bio", e.target.value)}
              rows={4}
              maxLength={500}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="Một vài thông tin để mọi người trong nhóm biết về bạn"
            />
            <div className="mt-1 text-right text-xs text-gray-400">{form.bio.length}/500</div>
          </div>
        </div>

        <Button className="w-full" onClick={handleSave} disabled={saving || !form.name.trim()}>
          <Save size={16} className="mr-2" />
          {saving ? "Đang lưu..." : "Lưu hồ sơ"}
        </Button>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <UserCircle size={18} className="text-green-600" />
          <h2 className="font-semibold text-gray-900">Hồ sơ trong nhóm</h2>
        </div>
        {otherProfiles.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-4 text-sm text-gray-500">
            Chưa có hồ sơ thành viên khác.
          </div>
        ) : (
          <div className="space-y-2">
            {otherProfiles.map((item) => (
              <Link
                key={item.id}
                to={`/profiles/${item.id}`}
                className="flex items-center justify-between bg-white rounded-xl border border-gray-100 p-3 shadow-sm hover:border-green-200 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={item.name} color="#16a34a" imageUrl={item.avatarUrl} />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{item.name}</div>
                    <div className="text-xs text-gray-500 truncate">{item.email}</div>
                  </div>
                </div>
                <div className="hidden sm:flex flex-col items-end text-xs text-gray-400">
                  {item.phone && <span className="flex items-center gap-1"><Phone size={11} />{item.phone}</span>}
                  {item.location && <span className="flex items-center gap-1"><MapPin size={11} />{item.location}</span>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
