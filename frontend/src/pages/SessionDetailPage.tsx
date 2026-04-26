import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";

import { ArrowLeft, Trash2, RefreshCw, Plus, Copy, Check, Share2, UserMinus, UserPlus } from "lucide-react";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useMembersStore } from "@/stores/membersStore";
import { useSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/permissions";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Cost } from "@/types";

const TABS = ["Check-in", "Chi phí", "Thanh toán"] as const;
type Tab = (typeof TABS)[number];

const COST_TYPES = [
  { value: "court", label: "Tiền sân" },
  { value: "water", label: "Nước" },
  { value: "shuttle", label: "Cầu" },
  { value: "other", label: "Khác" },
];

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: authSession } = useSession();
  const { currentSession, loading, fetchOne, refresh, remove } = useSessionsStore();
  const { members, fetch: fetchMembers } = useMembersStore();
  const [tab, setTab] = useState<Tab>("Check-in");
  const [costForm, setCostForm] = useState({ label: "", amount: "", type: "court" });
  const [addingCost, setAddingCost] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const isAdmin = isAdminUser(authSession?.user);

  useEffect(() => {
    if (id) { fetchOne(id); fetchMembers(); }
  }, [id]);

  const s = currentSession;
  if (loading && !s) return <div className="text-center py-16 text-gray-400">Đang tải...</div>;
  if (!s) return <div className="text-center py-16 text-gray-400">Không tìm thấy buổi chơi</div>;

  const checkedInIds = new Set(s.members.map((m) => m.id));
  const currentUserId = (authSession?.user as { id?: string } | undefined)?.id;
  const myMember = currentUserId ? s.members.find((m) => m.user_id === currentUserId) : undefined;
  const hasJoined = Boolean(myMember);

  const toggleMember = async (memberId: string) => {
    if (!isAdmin) return;
    const newIds = checkedInIds.has(memberId)
      ? [...checkedInIds].filter((x) => x !== memberId)
      : [...checkedInIds, memberId];
    await api.setSessionMembers(s.id, newIds);
    await refresh(s.id);
  };

  const handleJoinToggle = async () => {
    if (s.status !== "upcoming") return;
    setJoining(true);
    try {
      if (hasJoined) {
        await api.leaveSession(s.id);
      } else {
        await api.joinSession(s.id);
      }
      await refresh(s.id);
      await fetchMembers();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setJoining(false);
    }
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/sessions/${s.id}`;
    const title = `Buổi cầu lông tại ${s.venue}`;
    const text = `${formatDate(s.date)} · ${s.start_time}${s.location ? ` · ${s.location}` : ""}`;

    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    }
  };

  const handleAddCost = async () => {
    if (!costForm.label || !costForm.amount) return;
    setAddingCost(true);
    try {
      await api.addCost(s.id, { label: costForm.label, amount: parseFloat(costForm.amount), type: costForm.type as Cost["type"] });
      setCostForm({ label: "", amount: "", type: "court" });
      await refresh(s.id);
    } finally { setAddingCost(false); }
  };

  const handleDeleteCost = async (costId: string) => {
    await api.deleteCost(s.id, costId);
    await refresh(s.id);
  };

  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      await api.recalculate(s.id);
      await refresh(s.id);
    } catch (e: any) {
      alert(e.message);
    } finally { setRecalculating(false); }
  };

  const handleTogglePayment = async (paymentId: string) => {
    await api.togglePayment(paymentId);
    await refresh(s.id);
  };

  const handleDeleteSession = async () => {
    if (!confirm("Xóa buổi chơi này?")) return;
    await remove(s.id);
    navigate("/sessions");
  };

  const handleMarkComplete = async () => {
    await api.updateSession(s.id, { status: "completed" } as any);
    await refresh(s.id);
  };

  const totalCost = s.costs.reduce((sum, c) => sum + c.amount, 0);
  const perPerson = s.members.length > 0 ? Math.ceil(totalCost / s.members.length) : 0;

  const copyNotification = () => {
    const memberNames = s.members.map((m) => m.name).join(", ");
    const costBreakdown = s.costs.map((c) => `${c.label}: ${formatCurrency(c.amount)}`).join(" | ");
    const text = `🏸 Buổi chơi ${formatDate(s.date)} tại ${s.venue}\n📍 ${s.location ?? ""}\n👥 Tham gia: ${memberNames}\n💰 Mỗi người đóng: ${formatCurrency(perPerson)}\n(${costBreakdown})`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Link to="/sessions" className="p-2 rounded-lg hover:bg-gray-100">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 truncate">{s.venue}</h1>
          <div className="text-sm text-gray-500">{formatDate(s.date)} · {s.start_time}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={s.status === "upcoming" ? "green" : "gray"}>
            {s.status === "upcoming" ? "Sắp tới" : "Hoàn thành"}
          </Badge>
          {isAdmin && (
            <Button variant="ghost" size="icon" onClick={handleDeleteSession} className="text-red-500">
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </div>

      {/* Status toggle */}
      {isAdmin && s.status === "upcoming" && (
        <button onClick={handleMarkComplete}
          className="w-full bg-green-50 border border-green-200 text-green-700 text-sm font-medium rounded-xl py-2 mb-4 hover:bg-green-100 transition-colors">
          Đánh dấu hoàn thành
        </button>
      )}

      <div className="grid grid-cols-2 gap-2 mb-4">
        <Button
          onClick={handleJoinToggle}
          disabled={joining || s.status !== "upcoming"}
          variant={hasJoined ? "outline" : "default"}
          className="w-full"
        >
          {hasJoined ? <UserMinus size={16} className="mr-2" /> : <UserPlus size={16} className="mr-2" />}
          {joining ? "Đang xử lý..." : hasJoined ? "Rời buổi" : "Tham gia"}
        </Button>
        <Button variant="outline" onClick={handleShare} className="w-full">
          {shareCopied ? <Check size={16} className="mr-2 text-green-600" /> : <Share2 size={16} className="mr-2" />}
          {shareCopied ? "Đã copy" : "Chia sẻ"}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex bg-gray-100 rounded-xl p-1 mb-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${tab === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Tab: Check-in */}
      {tab === "Check-in" && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-gray-500">{s.members.length} người tham gia</span>
          </div>
          <div className="space-y-2">
            {(isAdmin ? members.filter((m) => m.is_active) : s.members).map((m) => {
              const checked = checkedInIds.has(m.id);
              return (
                <button key={m.id} onClick={() => toggleMember(m.id)} disabled={!isAdmin}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-colors ${checked ? "bg-green-50 border-green-200" : "bg-white border-gray-100"}`}>
                  <Avatar name={m.name} color={m.avatar_color} size="sm" />
                  <span className="flex-1 text-left font-medium text-gray-900">{m.name}</span>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${checked ? "bg-green-600 border-green-600" : "border-gray-300"}`}>
                    {checked && <Check size={12} className="text-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab: Chi phí */}
      {tab === "Chi phí" && (
        <div className="space-y-4">
          {isAdmin && (
            <div className="bg-gray-50 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <select value={costForm.type} onChange={(e) => setCostForm((f) => ({ ...f, type: e.target.value, label: COST_TYPES.find(t => t.value === e.target.value)?.label ?? "" }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
                  {COST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <Input value={costForm.amount} onChange={(e) => setCostForm((f) => ({ ...f, amount: e.target.value }))} placeholder="Số tiền" type="number" min="0" />
              </div>
              <Input value={costForm.label} onChange={(e) => setCostForm((f) => ({ ...f, label: e.target.value }))} placeholder="Mô tả (vd: Tiền sân 2h)" />
              <Button className="w-full" onClick={handleAddCost} disabled={addingCost || !costForm.label || !costForm.amount}>
                <Plus size={16} className="mr-1" />
                {addingCost ? "Đang thêm..." : "Thêm khoản chi"}
              </Button>
            </div>
          )}

          {s.costs.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">Chưa có khoản chi nào</div>
          ) : (
            <div className="space-y-2">
              {s.costs.map((c) => (
                <div key={c.id} className="flex items-center justify-between bg-white rounded-xl p-3 border border-gray-100">
                  <div>
                    <div className="font-medium text-gray-900">{c.label}</div>
                    <div className="text-xs text-gray-500">{COST_TYPES.find((t) => t.value === c.type)?.label ?? c.type}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{formatCurrency(c.amount)}</span>
                    {isAdmin && (
                      <Button variant="ghost" size="icon" onClick={() => handleDeleteCost(c.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between bg-green-50 rounded-xl p-3 border border-green-200">
                <span className="font-semibold text-green-800">Tổng cộng</span>
                <span className="font-bold text-green-800">{formatCurrency(totalCost)}</span>
              </div>
            </div>
          )}

          {isAdmin && s.costs.length > 0 && s.members.length > 0 && (
            <Button variant="outline" className="w-full" onClick={handleRecalculate} disabled={recalculating}>
              <RefreshCw size={16} className={`mr-2 ${recalculating ? "animate-spin" : ""}`} />
              Tính lại ({formatCurrency(perPerson)}/người)
            </Button>
          )}
        </div>
      )}

      {/* Tab: Thanh toán */}
      {tab === "Thanh toán" && (
        <div className="space-y-3">
          <Button variant="outline" size="sm" onClick={copyNotification} className="w-full">
            {copied ? <><Check size={14} className="mr-1 text-green-600" /> Đã copy!</> : <><Copy size={14} className="mr-1" /> Copy thông báo</>}
          </Button>

          {s.payments.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">Chưa tính tiền. Vào tab Chi phí để tính.</div>
          ) : (
            <div className="space-y-2">
              {s.payments.map((p) => {
                const member = members.find((m) => m.id === p.member_id) ?? s.members.find((m) => m.id === p.member_id);
                return (
                  <div key={p.id}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${p.paid ? "bg-green-50 border-green-200" : "bg-white border-gray-100"}`}>
                    <div className="flex items-center gap-3">
                      {member && <Avatar name={member.name} color={member.avatar_color} size="sm" />}
                      <div>
                        <div className="font-medium text-gray-900">{member?.name ?? p.member_id}</div>
                        <div className="text-sm font-semibold text-gray-700">{formatCurrency(p.amount_owed)}</div>
                      </div>
                    </div>
                    <button onClick={() => handleTogglePayment(p.id)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${p.paid ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                      {p.paid ? "Đã trả ✓" : "Chưa trả"}
                    </button>
                  </div>
                );
              })}
              <div className="flex items-center justify-between bg-gray-50 rounded-xl p-3">
                <span className="text-sm text-gray-600">
                  Đã trả: {s.payments.filter((p) => p.paid).length}/{s.payments.length}
                </span>
                <span className="font-semibold text-gray-900">
                  {formatCurrency(s.payments.filter((p) => p.paid).reduce((sum, p) => sum + p.amount_owed, 0))} / {formatCurrency(totalCost)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
