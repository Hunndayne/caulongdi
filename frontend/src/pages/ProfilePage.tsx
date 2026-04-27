import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, MapPin, Phone, Save, UserCircle, Landmark } from "lucide-react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signOut } from "@/lib/auth-client";
import { useGroupsStore } from "@/stores/groupsStore";
import type { ProfileUpdateInput, UserProfile } from "@/types";
import banksData from "@/lib/banks.json";

const banks = (banksData as any).data.filter((b: any) => b.transferSupported === 1);

const emptyForm: Required<ProfileUpdateInput> = {
  name: "",
  phone: "",
  bio: "",
  birthday: "",
  location: "",
  avatarUrl: "",
  bankBin: "",
  bankAccountNumber: "",
  bankAccountName: "",
};

function profileToForm(profile: UserProfile): Required<ProfileUpdateInput> {
  return {
    name: profile.name ?? "",
    phone: profile.phone ?? "",
    bio: profile.bio ?? "",
    birthday: profile.birthday ?? "",
    location: profile.location ?? "",
    avatarUrl: profile.avatarUrl ?? "",
    bankBin: profile.bankBin ?? "",
    bankAccountNumber: profile.bankAccountNumber ?? "",
    bankAccountName: profile.bankAccountName ?? "",
  };
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const activeGroupId = useGroupsStore((state) => state.activeGroupId);
  const fetchGroups = useGroupsStore((state) => state.fetch);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getMyProfile(),
      activeGroupId ? api.getProfiles(activeGroupId) : Promise.resolve([] as UserProfile[]),
    ])
      .then(([me, all]) => {
        setProfile(me);
        setProfiles(all);
        setForm(profileToForm(me));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được hồ sơ"))
      .finally(() => setLoading(false));
  }, [activeGroupId]);

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
    return <div className="py-12 text-center text-gray-400">Đang tải...</div>;
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

      <section className="space-y-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <Avatar name={form.name || "Bạn"} color="#16a34a" size="lg" imageUrl={form.avatarUrl || undefined} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-gray-900">{form.name || "Hồ sơ của bạn"}</div>
            <div className="truncate text-sm text-gray-500">{profile?.email}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Tên hiển thị *</label>
            <Input value={form.name} onChange={(e) => updateForm("name", e.target.value)} placeholder="Tên của bạn" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Số điện thoại</label>
            <Input value={form.phone} onChange={(e) => updateForm("phone", e.target.value)} placeholder="0912345678" type="tel" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Ngày sinh</label>
            <Input value={form.birthday} onChange={(e) => updateForm("birthday", e.target.value)} type="date" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Khu vực</label>
            <Input value={form.location} onChange={(e) => updateForm("location", e.target.value)} placeholder="Quận / thành phố" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Ảnh đại diện URL</label>
            <Input value={form.avatarUrl} onChange={(e) => updateForm("avatarUrl", e.target.value)} placeholder="https://..." />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Giới thiệu</label>
            <textarea
              value={form.bio}
              onChange={(e) => updateForm("bio", e.target.value)}
              rows={4}
              maxLength={500}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-green-500"
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

      {/* Thông tin thanh toán */}
      <section className="space-y-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Landmark size={18} className="text-green-600" />
          <h2 className="font-semibold text-gray-900">Thông tin thanh toán</h2>
        </div>
        <p className="text-xs text-gray-400">Để nhóm tạo mã QR chuyển khoản nhanh cho bạn.</p>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Ngân hàng</label>
            <select
              value={form.bankBin}
              onChange={(e) => updateForm("bankBin", e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">-- Chọn ngân hàng --</option>
              {banks.map((b: any) => (
                <option key={b.bin} value={b.bin}>{b.shortName} - {b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Số tài khoản</label>
            <Input value={form.bankAccountNumber} onChange={(e) => updateForm("bankAccountNumber", e.target.value)} placeholder="0123456789" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Tên chủ tài khoản</label>
            <Input
              value={form.bankAccountName}
              onChange={(e) => updateForm("bankAccountName", e.target.value.toUpperCase())}
              placeholder="NGUYEN VAN A"
            />
            <p className="mt-1 text-xs text-gray-400">In hoa, không dấu</p>
          </div>
        </div>
        <Button className="w-full" onClick={handleSave} disabled={saving || !form.name.trim()}>
          <Save size={16} className="mr-2" />
          {saving ? "Đang lưu..." : "Lưu thông tin"}
        </Button>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <UserCircle size={18} className="text-green-600" />
          <h2 className="font-semibold text-gray-900">Hồ sơ trong nhóm</h2>
        </div>
        {!activeGroupId ? (
          <div className="rounded-xl border border-gray-100 bg-white p-4 text-sm text-gray-500">
            Chọn nhóm ở trang Thành viên để xem danh sách hồ sơ.
          </div>
        ) : otherProfiles.length === 0 ? (
          <div className="rounded-xl border border-gray-100 bg-white p-4 text-sm text-gray-500">
            Chưa có hồ sơ thành viên khác trong nhóm này.
          </div>
        ) : (
          <div className="space-y-2">
            {otherProfiles.map((item) => (
              <Link
                key={item.id}
                to={`/profiles/${item.id}`}
                className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-3 shadow-sm transition-colors hover:border-green-200"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={item.name} color="#16a34a" imageUrl={item.avatarUrl} />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-gray-900">{item.name}</div>
                    <div className="truncate text-xs text-gray-500">{item.email}</div>
                  </div>
                </div>
                <div className="hidden flex-col items-end text-xs text-gray-400 sm:flex">
                  {item.phone && (
                    <span className="flex items-center gap-1">
                      <Phone size={11} />
                      {item.phone}
                    </span>
                  )}
                  {item.location && (
                    <span className="flex items-center gap-1">
                      <MapPin size={11} />
                      {item.location}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
