import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRightLeft,
  Check,
  Copy,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react";

import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/permissions";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useGroupsStore } from "@/stores/groupsStore";
import { useMembersStore } from "@/stores/membersStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import type { Cost, Member } from "@/types";

const TABS = ["Check-in", "Chi phi", "Thanh toan"] as const;
type Tab = (typeof TABS)[number];

const COST_TYPES = [
  { value: "court", label: "Tien san" },
  { value: "water", label: "Nuoc" },
  { value: "shuttle", label: "Cau" },
  { value: "other", label: "Khac" },
] as const;

function parseManagers(raw?: string | null) {
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function getCostTypeLabel(type: string) {
  return COST_TYPES.find((item) => item.value === type)?.label ?? type;
}

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: authSession } = useSession();
  const { currentSession, loading, fetchOne, refresh, remove } = useSessionsStore();
  const { members, fetch: fetchMembers } = useMembersStore();
  const groups = useGroupsStore((state) => state.groups);
  const fetchGroups = useGroupsStore((state) => state.fetch);

  const [tab, setTab] = useState<Tab>("Check-in");
  const [costForm, setCostForm] = useState({
    label: "",
    amount: "",
    type: "court",
    payerId: "",
    consumerId: "",
  });
  const [addingCost, setAddingCost] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [managingSettings, setManagingSettings] = useState(false);
  const [showManagerSettings, setShowManagerSettings] = useState(false);
  const [recipientId, setRecipientId] = useState("");

  const currentUserId = (authSession?.user as { id?: string } | undefined)?.id;
  const managersList = useMemo(() => parseManagers(currentSession?.managers), [currentSession?.managers]);
  const groupRole = currentSession?.group_id
    ? groups.find((group) => group.id === currentSession.group_id)?.role
    : undefined;

  const canManageSession = Boolean(
    isAdminUser(authSession?.user) ||
    (currentUserId && currentSession?.created_by === currentUserId) ||
    (currentUserId && managersList.includes(currentUserId)) ||
    groupRole === "admin"
  );

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    if (id) fetchOne(id);
  }, [id, fetchOne]);

  useEffect(() => {
    if (!currentSession) return;
    fetchMembers(currentSession.group_id);
  }, [currentSession, fetchMembers]);

  useEffect(() => {
    setRecipientId(currentSession?.payment_recipient ?? "");
  }, [currentSession?.id, currentSession?.payment_recipient]);

  const s = currentSession;

  if (loading && !s) {
    return <div className="py-16 text-center text-gray-400">Dang tai...</div>;
  }

  if (!s) {
    return <div className="py-16 text-center text-gray-400">Khong tim thay buoi choi</div>;
  }

  const checkedInIds = new Set(s.members.map((member) => member.id));
  const myMember = currentUserId ? s.members.find((member) => member.user_id === currentUserId) : undefined;
  const hasJoined = Boolean(myMember);

  const allMembers = [...members, ...s.members];
  const memberById = new Map<string, Member>();
  for (const member of allMembers) {
    if (!memberById.has(member.id)) memberById.set(member.id, member);
  }

  const membersWithBank = s.members.filter(
    (member) => member.user_bank_bin && member.user_bank_account_number && member.user_bank_account_name
  );
  const fallbackRecipientMember = recipientId ? memberById.get(recipientId) ?? null : null;

  const paymentRows = [...s.payments]
    .map((payment) => ({
      payment,
      debtor: memberById.get(payment.member_id) ?? null,
      recipient: payment.recipient_member_id ? memberById.get(payment.recipient_member_id) ?? null : null,
    }))
    .sort((a, b) => {
      if (a.payment.paid !== b.payment.paid) return a.payment.paid - b.payment.paid;
      return b.payment.amount_owed - a.payment.amount_owed;
    });

  const handleSetRecipient = async (value: string) => {
    setRecipientId(value);
    if (!canManageSession || !id) return;
    try {
      await api.updateSession(id, { payment_recipient: value || null } as any);
    } catch {
      // keep local selection optimistic; refresh will reconcile if needed
    }
  };

  const toggleMember = async (memberId: string) => {
    if (!canManageSession) return;
    const nextIds = checkedInIds.has(memberId)
      ? [...checkedInIds].filter((idValue) => idValue !== memberId)
      : [...checkedInIds, memberId];
    await api.setSessionMembers(s.id, nextIds);
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
      await fetchMembers(s.group_id);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setJoining(false);
    }
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/sessions/${s.id}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${s.venue} - ${formatDate(s.date)}`,
          text: `Buoi choi tai ${s.venue}`,
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      } catch (clipboardError: any) {
        alert(`Khong the chia se link: ${clipboardError.message}`);
      }
    }
  };

  const handleAddCost = async () => {
    if (!costForm.label.trim() || !costForm.amount) return;
    if (costForm.consumerId && !costForm.payerId) {
      alert("Khoan chi rieng can chon nguoi ung tien.");
      return;
    }

    setAddingCost(true);
    try {
      await api.addCost(s.id, {
        label: costForm.label.trim(),
        amount: parseFloat(costForm.amount),
        type: costForm.type as Cost["type"],
        payer_id: costForm.payerId || null,
        consumer_id: costForm.consumerId || null,
      });
      setCostForm({ label: "", amount: "", type: "court", payerId: "", consumerId: "" });
      await refresh(s.id);
    } finally {
      setAddingCost(false);
    }
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
    } catch (error: any) {
      alert(error.message);
    } finally {
      setRecalculating(false);
    }
  };

  const handleTogglePayment = async (paymentId: string) => {
    try {
      await api.togglePayment(paymentId);
      await refresh(s.id);
    } catch (error: any) {
      alert(error.message);
    }
  };

  const handleDeleteSession = async () => {
    if (!window.confirm("Xoa buoi choi nay?")) return;
    await remove(s.id);
    navigate("/sessions");
  };

  const handleMarkComplete = async () => {
    await api.updateSession(s.id, { status: "completed" } as any);
    await refresh(s.id);
  };

  const totalCost = s.costs.reduce((sum, cost) => sum + cost.amount, 0);

  const buildQrUrl = (debtor: Member, recipient: Member, amount: number) => {
    if (!recipient.user_bank_bin || !recipient.user_bank_account_number || !recipient.user_bank_account_name) return null;
    if (amount <= 0 || debtor.id === recipient.id) return null;
    const note = `${debtor.name} chuyen ${recipient.name} ${formatDate(s.date)}`;
    return `https://img.vietqr.io/image/${recipient.user_bank_bin}-${recipient.user_bank_account_number}-compact.png?amount=${Math.ceil(amount)}&addInfo=${encodeURIComponent(note)}&accountName=${encodeURIComponent(recipient.user_bank_account_name)}`;
  };

  const canTogglePaymentRow = (debtor: Member | null, recipient: Member | null) => {
    if (canManageSession) return true;
    if (!currentUserId) return false;
    return debtor?.user_id === currentUserId || recipient?.user_id === currentUserId;
  };

  const getPaymentActionLabel = (paid: number, debtor: Member | null, recipient: Member | null) => {
    const isRecipientUser = Boolean(currentUserId && recipient?.user_id === currentUserId && debtor?.user_id !== currentUserId);
    if (paid) return isRecipientUser ? "Da nhan ✓" : "Da tra ✓";
    return isRecipientUser ? "Xac nhan nhan" : "Danh dau da tra";
  };

  const copyNotification = async () => {
    const costBreakdown = s.costs.length > 0
      ? s.costs.map((cost) => `${cost.label}: ${formatCurrency(cost.amount)}`).join(" | ")
      : "Chua co khoan chi";
    const paymentLines = paymentRows.length > 0
      ? paymentRows.map(({ payment, debtor, recipient }) => {
        const debtorName = debtor?.name ?? payment.member_id;
        const recipientName = recipient?.name ?? payment.recipient_member_id ?? "nguoi nhan";
        return `- ${debtorName} -> ${recipientName}: ${formatCurrency(payment.amount_owed)}${payment.paid ? " (da xong)" : ""}`;
      }).join("\n")
      : "- Chua tinh tien";

    const text = [
      `Buoi choi ${formatDate(s.date)} tai ${s.venue}`,
      `Dia diem: ${s.location ?? "-"}`,
      `Tham gia: ${s.members.map((member) => member.name).join(", ")}`,
      "",
      `Chi phi: ${costBreakdown}`,
      "",
      "Can chuyen:",
      paymentLines,
    ].join("\n");

    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const creatorName = s.members.find((member) => member.user_id === s.created_by)?.name ?? "An danh";

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/sessions" className="rounded-lg p-2 hover:bg-gray-100">
          <ArrowLeft size={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-gray-900">{s.venue}</h1>
          <div className="text-sm text-gray-500">
            {formatDate(s.date)} · {s.start_time}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={s.status === "upcoming" ? "green" : "gray"}>
            {s.status === "upcoming" ? "Sap toi" : "Hoan thanh"}
          </Badge>
          {canManageSession && (
            <Button variant="ghost" size="icon" onClick={handleDeleteSession} className="text-red-500">
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </div>

      {canManageSession && s.status === "upcoming" && (
        <button
          onClick={handleMarkComplete}
          className="mb-4 w-full rounded-xl border border-green-200 bg-green-50 py-2 text-sm font-medium text-green-700 transition-colors hover:bg-green-100"
        >
          Danh dau hoan thanh
        </button>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2">
        <Button
          onClick={handleJoinToggle}
          disabled={joining || s.status !== "upcoming"}
          variant={hasJoined ? "outline" : "default"}
          className="w-full"
        >
          {hasJoined ? <UserMinus size={16} className="mr-2" /> : <UserPlus size={16} className="mr-2" />}
          {joining ? "Dang xu ly..." : hasJoined ? "Roi buoi" : "Tham gia"}
        </Button>
        <Button variant="outline" onClick={handleShare} className="w-full">
          {shareCopied ? <Check size={16} className="mr-2 text-green-600" /> : <Share2 size={16} className="mr-2" />}
          {shareCopied ? "Da copy" : "Chia se"}
        </Button>
      </div>

      {canManageSession && (
        <div className="mb-4">
          {!showManagerSettings ? (
            <button
              onClick={() => setShowManagerSettings(true)}
              className="flex w-full items-center justify-center gap-2 py-1.5 text-sm text-gray-500 transition-colors hover:text-gray-700"
            >
              <ArrowRightLeft size={14} />
              Cai dat quan ly
            </button>
          ) : (
            <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <div className="text-xs font-semibold text-gray-700">Nguoi tao: {creatorName}</div>

              {managersList.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-gray-500">Dong quan ly:</div>
                  <div className="flex flex-wrap gap-2">
                    {managersList.map((userId) => {
                      const managerMember = s.members.find((member) => member.user_id === userId);
                      if (!managerMember) return null;
                      return (
                        <Badge key={userId} variant="gray" className="flex items-center gap-1">
                          {managerMember.name}
                          <button
                            onClick={async () => {
                              if (!window.confirm(`Xoa quyen quan ly cua ${managerMember.name}?`)) return;
                              setManagingSettings(true);
                              try {
                                await api.removeSessionManager(s.id, managerMember.id);
                                await refresh(s.id);
                              } catch (error: any) {
                                alert(error.message);
                              } finally {
                                setManagingSettings(false);
                              }
                            }}
                            className="ml-1 text-gray-400 hover:text-red-500"
                          >
                            ×
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <select
                  id="manager-select"
                  className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Chon thanh vien
                  </option>
                  {s.members
                    .filter((member) => member.user_id && member.user_id !== s.created_by && !managersList.includes(member.user_id))
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={managingSettings}
                  onClick={async () => {
                    const selectedId = (document.getElementById("manager-select") as HTMLSelectElement | null)?.value;
                    if (!selectedId) return;
                    setManagingSettings(true);
                    try {
                      await api.addSessionManager(s.id, selectedId);
                      await refresh(s.id);
                    } catch (error: any) {
                      alert(error.message);
                    } finally {
                      setManagingSettings(false);
                    }
                  }}
                >
                  <Plus size={14} className="mr-1" />
                  Them
                </Button>
                <Button
                  size="sm"
                  disabled={managingSettings}
                  onClick={async () => {
                    const selectedId = (document.getElementById("manager-select") as HTMLSelectElement | null)?.value;
                    if (!selectedId) return;
                    if (!window.confirm("Chuyen quyen so huu buoi choi nay?")) return;
                    setManagingSettings(true);
                    try {
                      await api.transferSession(s.id, selectedId);
                      await refresh(s.id);
                      setShowManagerSettings(false);
                    } catch (error: any) {
                      alert(error.message);
                    } finally {
                      setManagingSettings(false);
                    }
                  }}
                >
                  Chuyen giao
                </Button>
              </div>

              <button
                onClick={() => setShowManagerSettings(false)}
                className="mt-2 w-full text-center text-xs text-gray-500 hover:text-gray-700"
              >
                Dong
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mb-4 flex rounded-xl bg-gray-100 p-1">
        {TABS.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${tab === item ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Check-in" && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-gray-500">{s.members.length} nguoi tham gia</span>
          </div>
          <div className="space-y-2">
            {(canManageSession ? members.filter((member) => member.is_active) : s.members).map((member) => {
              const checked = checkedInIds.has(member.id);
              return (
                <button
                  key={member.id}
                  onClick={() => toggleMember(member.id)}
                  disabled={!canManageSession}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 transition-colors ${checked ? "border-green-200 bg-green-50" : "border-gray-100 bg-white"}`}
                >
                  <Avatar name={member.name} color={member.avatar_color} size="sm" />
                  <span className="flex-1 text-left font-medium text-gray-900">{member.name}</span>
                  <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${checked ? "border-green-600 bg-green-600" : "border-gray-300"}`}>
                    {checked && <Check size={12} className="text-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === "Chi phi" && (
        <div className="space-y-4">
          {canManageSession && (
            <div className="space-y-3 rounded-xl bg-gray-50 p-4">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={costForm.type}
                  onChange={(event) =>
                    setCostForm((current) => ({
                      ...current,
                      type: event.target.value,
                      label: COST_TYPES.find((item) => item.value === event.target.value)?.label ?? current.label,
                    }))
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {COST_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <Input
                  value={costForm.amount}
                  onChange={(event) => setCostForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="So tien"
                  type="number"
                  min="0"
                />
              </div>

              <Input
                value={costForm.label}
                onChange={(event) => setCostForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="Mo ta"
              />

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Nguoi ung tien</label>
                  <select
                    value={costForm.payerId}
                    onChange={(event) => setCostForm((current) => ({ ...current, payerId: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Nguoi nhan chung</option>
                    {s.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Nguoi dung rieng</label>
                  <select
                    value={costForm.consumerId}
                    onChange={(event) => setCostForm((current) => ({ ...current, consumerId: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Dung chung</option>
                    {s.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <Button className="w-full" onClick={handleAddCost} disabled={addingCost || !costForm.label || !costForm.amount}>
                <Plus size={16} className="mr-1" />
                {addingCost ? "Dang them..." : "Them khoan chi"}
              </Button>
            </div>
          )}

          {s.costs.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Chua co khoan chi nao</div>
          ) : (
            <div className="space-y-2">
              {s.costs.map((cost) => {
                const payerMember = cost.payer_id ? memberById.get(cost.payer_id) ?? null : null;
                const consumerMember = cost.consumer_id ? memberById.get(cost.consumer_id) ?? null : null;

                let helperText = "Tra cho nguoi nhan chung";
                let helperClass = "text-green-500";
                if (payerMember && consumerMember) {
                  helperText = `${consumerMember.name} tra lai cho ${payerMember.name}`;
                  helperClass = "text-orange-500";
                } else if (payerMember) {
                  helperText = `Ca nhom tra lai cho ${payerMember.name}`;
                  helperClass = "text-blue-500";
                }

                return (
                  <div key={cost.id} className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-900">{cost.label}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span className="text-xs text-gray-400">{getCostTypeLabel(cost.type)}</span>
                        <span className={`text-xs ${helperClass}`}>{helperText}</span>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <span className="font-semibold text-gray-900">{formatCurrency(cost.amount)}</span>
                      {canManageSession && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteCost(cost.id)}
                          className="text-red-400 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 p-3">
                <span className="font-semibold text-green-800">Tong cong</span>
                <span className="font-bold text-green-800">{formatCurrency(totalCost)}</span>
              </div>
            </div>
          )}

          {canManageSession && s.costs.length > 0 && s.members.length > 0 && (
            <>
              {membersWithBank.length > 0 && (
                <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-3">
                  <label className="block text-xs text-gray-500">Nguoi nhan chung / fallback</label>
                  <select
                    value={recipientId}
                    onChange={(event) => handleSetRecipient(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">-- Chua chon --</option>
                    {membersWithBank.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                  <div className="text-xs text-gray-500">
                    QR se uu tien hien theo nguoi ung tien. Neu nguoi do chua cap nhat STK, he thong moi dung nguoi nhan chung nay.
                  </div>
                </div>
              )}

              <Button variant="outline" className="w-full" onClick={handleRecalculate} disabled={recalculating}>
                <RefreshCw size={16} className={`mr-2 ${recalculating ? "animate-spin" : ""}`} />
                {recalculating ? "Dang tinh..." : "Tinh lai va cap nhat"}
              </Button>
            </>
          )}
        </div>
      )}

      {tab === "Thanh toan" && (
        <div className="space-y-3">
          <Button variant="outline" size="sm" onClick={copyNotification} className="w-full">
            {copied ? (
              <>
                <Check size={14} className="mr-1 text-green-600" />
                Da copy
              </>
            ) : (
              <>
                <Copy size={14} className="mr-1" />
                Copy thong bao
              </>
            )}
          </Button>

          {paymentRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Chua tinh tien. Vao tab Chi phi de tinh lai.</div>
          ) : (
            <div className="space-y-2">
              {paymentRows.map(({ payment, debtor, recipient }) => {
                const debtorName = debtor?.name ?? payment.member_id;
                const recipientName = recipient?.name ?? payment.recipient_member_id ?? "nguoi nhan";
                const recipientHasBank = Boolean(
                  recipient?.user_bank_bin && recipient?.user_bank_account_number && recipient?.user_bank_account_name
                );
                const qrRecipient = recipientHasBank
                  ? recipient
                  : (fallbackRecipientMember && fallbackRecipientMember.id !== payment.member_id ? fallbackRecipientMember : null);
                const qrUrl = debtor && qrRecipient ? buildQrUrl(debtor, qrRecipient, payment.amount_owed) : null;
                const fallbackNotice = !recipientHasBank && qrRecipient && recipient
                  ? `Nguoi ung tien chua cap nhat STK, tam chuyen qua ${qrRecipient.name}.`
                  : null;
                const toggleAllowed = canTogglePaymentRow(debtor, recipient);

                return (
                  <div
                    key={payment.id}
                    className={`rounded-xl border p-3 transition-colors ${payment.paid ? "border-green-200 bg-green-50" : "border-gray-100 bg-white"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {debtor && <Avatar name={debtor.name} color={debtor.avatar_color} size="sm" />}
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{debtorName}</div>
                          <div className="text-sm text-gray-500">Tra cho {recipientName}</div>
                          <div className="mt-0.5 text-sm font-semibold text-gray-800">
                            {formatCurrency(payment.amount_owed)}
                          </div>
                          {fallbackNotice && (
                            <div className="mt-1 text-xs text-amber-600">{fallbackNotice}</div>
                          )}
                          {!qrUrl && !payment.paid && (
                            <div className="mt-1 text-xs text-red-500">Chua co tai khoan nhan tien de tao QR.</div>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={() => handleTogglePayment(payment.id)}
                        disabled={!toggleAllowed}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${payment.paid
                          ? "bg-green-600 text-white"
                          : toggleAllowed
                            ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            : "cursor-not-allowed bg-gray-100 text-gray-400"
                          }`}
                      >
                        {getPaymentActionLabel(payment.paid, debtor, recipient)}
                      </button>
                    </div>

                    {qrUrl && !payment.paid && (
                      <div className="mt-3 flex flex-col items-center gap-2">
                        <img
                          src={qrUrl}
                          alt={`QR chuyen khoan cho ${qrRecipient?.name ?? recipientName}`}
                          className="h-auto w-48 rounded-lg border border-gray-200"
                          loading="lazy"
                        />
                        <div className="text-center text-xs text-gray-500">
                          QR nhan tien: {qrRecipient?.name ?? recipientName}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="space-y-1 rounded-xl bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Da xong</span>
                  <span className="text-sm font-medium text-gray-900">
                    {paymentRows.filter(({ payment }) => payment.paid).length}/{paymentRows.length} giao dich
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Tong can chuyen</span>
                  <span className="text-sm font-medium text-gray-900">
                    {formatCurrency(paymentRows.reduce((sum, row) => sum + row.payment.amount_owed, 0))}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
