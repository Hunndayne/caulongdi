import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRightLeft,
  Check,
  Copy,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  X,
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
import type { Cost, Member, Payment } from "@/types";

const TABS = ["Điểm danh", "Chi phí", "Thanh toán"] as const;
type Tab = (typeof TABS)[number];

const COST_TYPES = [
  { value: "court", label: "Tiền sân" },
  { value: "water", label: "Nước" },
  { value: "shuttle", label: "Cầu" },
  { value: "other", label: "Khác" },
] as const;

const COST_EXCEL_HEADERS = ["Mã", "Loại", "Mô tả", "Số tiền", "Người ứng tiền", "Người dùng riêng"] as const;

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

function normalizeImportText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function readImportCell(row: Record<string, unknown>, aliases: string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const normalizedAlias = normalizeImportText(alias);
    const match = entries.find(([key]) => normalizeImportText(key) === normalizedAlias);
    if (match) return match[1];
  }
  return "";
}

function parseImportAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function hasBankInfo(member: Member | null | undefined) {
  return Boolean(member?.user_bank_bin && member?.user_bank_account_number && member?.user_bank_account_name);
}

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: authSession } = useSession();
  const { currentSession, loading, fetchOne, refresh, remove } = useSessionsStore();
  const { members, fetch: fetchMembers } = useMembersStore();
  const groups = useGroupsStore((state) => state.groups);
  const fetchGroups = useGroupsStore((state) => state.fetch);

  const [tab, setTab] = useState<Tab>("Điểm danh");
  const [costForm, setCostForm] = useState({
    label: "",
    amount: "",
    type: "court",
    payerId: "",
    consumerId: "",
    consumerPending: 0,
  });
  const [addingCost, setAddingCost] = useState(false);
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [importingCosts, setImportingCosts] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [managingSettings, setManagingSettings] = useState(false);
  const [showManagerSettings, setShowManagerSettings] = useState(false);
  const [recipientId, setRecipientId] = useState("");
  const costImportInputRef = useRef<HTMLInputElement | null>(null);

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
    return <div className="py-16 text-center text-gray-400">Đang tải...</div>;
  }

  if (!s) {
    return <div className="py-16 text-center text-gray-400">Không tìm thấy buổi chơi</div>;
  }

  const checkedInIds = new Set(s.members.map((member) => member.id));
  const myMember = currentUserId ? s.members.find((member) => member.user_id === currentUserId) : undefined;
  const hasJoined = Boolean(myMember);

  const allMembers = [...members, ...s.members];
  const memberById = new Map<string, Member>();
  for (const member of allMembers) {
    const existing = memberById.get(member.id);
    if (!existing) {
      memberById.set(member.id, member);
      continue;
    }

    const existingHasBank = hasBankInfo(existing);
    const nextHasBank = hasBankInfo(member);
    if (!existingHasBank && nextHasBank) {
      memberById.set(member.id, member);
      continue;
    }

    if (existingHasBank === nextHasBank && s.members.some((sessionMember) => sessionMember.id === member.id)) {
      memberById.set(member.id, member);
    }
  }

  const membersWithBank = Array.from(memberById.values()).filter(hasBankInfo);
  const fallbackRecipientMember = recipientId ? memberById.get(recipientId) ?? null : null;
  const memberByImportName = new Map<string, Member>();
  for (const member of memberById.values()) {
    memberByImportName.set(normalizeImportText(member.name), member);
    if (member.user_email) memberByImportName.set(normalizeImportText(member.user_email), member);
  }

  const paymentRows = [...s.payments]
    .map((payment) => ({
      payment,
      debtor: memberById.get(payment.member_id) ?? null,
      recipient: payment.recipient_member_id ? memberById.get(payment.recipient_member_id) ?? null : null,
    }))
    .sort((a, b) => {
      const rank = (payment: Payment) => payment.paid ? 2 : payment.payer_marked_paid ? 1 : 0;
      const rankDiff = rank(a.payment) - rank(b.payment);
      if (rankDiff !== 0) return rankDiff;
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
          text: `Buổi chơi tại ${s.venue}`,
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
        alert(`Không thể chia sẻ link: ${clipboardError.message}`);
      }
    }
  };

  const resolveImportedMember = (value: unknown, rowNumber: number, columnName: string) => {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const member = memberByImportName.get(normalizeImportText(raw));
    if (!member) {
      throw new Error(`Dòng ${rowNumber}: không tìm thấy thành viên "${raw}" ở cột ${columnName}.`);
    }
    return member;
  };

  const handleExportCosts = async () => {
    const XLSX = await import("xlsx");
    const costRows = s.costs.map((cost) => {
      const payer = cost.payer_id ? memberById.get(cost.payer_id) : null;
      const consumer = cost.consumer_pending ? null : (cost.consumer_id ? memberById.get(cost.consumer_id) : null);
      return [
        cost.id,
        getCostTypeLabel(cost.type),
        cost.label,
        cost.amount,
        payer?.name ?? "",
        cost.consumer_pending ? "Chưa rõ" : (consumer?.name ?? ""),
      ];
    });

    const workbook = XLSX.utils.book_new();
    const costSheet = XLSX.utils.aoa_to_sheet([[...COST_EXCEL_HEADERS], ...costRows]);
    costSheet["!cols"] = [
      { wch: 24 },
      { wch: 14 },
      { wch: 28 },
      { wch: 14 },
      { wch: 24 },
      { wch: 24 },
    ];
    XLSX.utils.book_append_sheet(workbook, costSheet, "Chi phí");

    const memberSheet = XLSX.utils.aoa_to_sheet([
      ["Tên thành viên", "Email"],
      ...Array.from(memberById.values()).map((member) => [member.name, member.user_email ?? ""]),
    ]);
    memberSheet["!cols"] = [{ wch: 28 }, { wch: 32 }];
    XLSX.utils.book_append_sheet(workbook, memberSheet, "Thành viên");

    const safeDate = s.date.replace(/[^\d-]/g, "");
    XLSX.writeFile(workbook, `chi-phi-${safeDate || s.id}.xlsx`);
  };

  const handleImportCosts = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportingCosts(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets["Chi phí"] ?? workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("Không tìm thấy sheet chi phí trong file.");

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const parsedCosts = rows
        .map((row, index) => {
          const rowNumber = index + 2;
          const costIdRaw = readImportCell(row, ["Mã", "Ma", "ID", "Cost ID"]);
          const typeRaw = readImportCell(row, ["Loại", "Loai", "Type"]);
          const labelRaw = readImportCell(row, ["Mô tả", "Mo ta", "Mô tả khoản chi", "Label"]);
          const amountRaw = readImportCell(row, ["Số tiền", "So tien", "Amount"]);
          const payerRaw = readImportCell(row, ["Người ứng tiền", "Nguoi ung tien", "Người trả", "Payer"]);
          const consumerRaw = readImportCell(row, ["Người dùng riêng", "Nguoi dung rieng", "Người dùng", "Consumer"]);

          const isEmpty = [costIdRaw, typeRaw, labelRaw, amountRaw, payerRaw, consumerRaw]
            .every((value) => String(value ?? "").trim() === "");
          if (isEmpty) return null;

          const costId = String(costIdRaw ?? "").trim();
          const amount = parseImportAmount(amountRaw);
          if (!amount) throw new Error(`Dòng ${rowNumber}: số tiền không hợp lệ.`);

          const typeKey = normalizeImportText(typeRaw);
          const type = (COST_TYPES.find((item) =>
            normalizeImportText(item.label) === typeKey || normalizeImportText(item.value) === typeKey
          )?.value ?? "other") as Cost["type"];
          const label = String(labelRaw || getCostTypeLabel(type)).trim();
          const payer = resolveImportedMember(payerRaw, rowNumber, "Người ứng tiền");
          const consumerRawNormalized = normalizeImportText(consumerRaw);
          const isPending = consumerRawNormalized === "chua ro" || consumerRawNormalized === "chưa rõ";
          const consumer = isPending ? null : resolveImportedMember(consumerRaw, rowNumber, "Người dùng riêng");

          return {
            label,
            amount,
            type,
            payer_id: payer?.id ?? null,
            consumer_id: consumer?.id ?? null,
            consumer_pending: isPending ? 1 : 0,
            costId: costId || null,
          };
        })
        .filter((item): item is {
          label: string;
          amount: number;
          type: Cost["type"];
          payer_id: string | null;
          consumer_id: string | null;
          consumer_pending: number;
          costId: string | null;
        } => Boolean(item));

      if (parsedCosts.length === 0) throw new Error("File không có dòng chi phí hợp lệ.");

      for (const cost of parsedCosts) {
        const { costId, ...payload } = cost;
        if (costId) {
          await api.updateCost(s.id, costId, payload);
        } else {
          await api.addCost(s.id, payload);
        }
      }

      resetCostForm();
      await refresh(s.id);
      alert(`Đã nhập ${parsedCosts.length} khoản chi.`);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setImportingCosts(false);
    }
  };

  const resetCostForm = () => {
    setCostForm({ label: "", amount: "", type: "court", payerId: "", consumerId: "", consumerPending: 0 });
    setEditingCostId(null);
  };

  const handleStartEditCost = (cost: Cost) => {
    setEditingCostId(cost.id);
    setCostForm({
      label: cost.label,
      amount: String(cost.amount),
      type: cost.type,
      payerId: cost.payer_id ?? "",
      consumerId: cost.consumer_id ?? "",
      consumerPending: cost.consumer_pending ?? 0,
    });
  };

  const handleSaveCost = async () => {
    if (!costForm.label.trim() || !costForm.amount) return;

    setAddingCost(true);
    try {
      const payload = {
        label: costForm.label.trim(),
        amount: parseFloat(costForm.amount),
        type: costForm.type as Cost["type"],
        payer_id: costForm.payerId || null,
        consumer_id: costForm.consumerId || null,
        consumer_pending: costForm.consumerPending,
      };

      if (editingCostId) {
        await api.updateCost(s.id, editingCostId, payload);
      } else {
        await api.addCost(s.id, payload);
      }

      resetCostForm();
      await refresh(s.id);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setAddingCost(false);
    }
  };

  const handleDeleteCost = async (costId: string) => {
    try {
      await api.deleteCost(s.id, costId);
      if (editingCostId === costId) resetCostForm();
      await refresh(s.id);
    } catch (error: any) {
      alert(error.message);
    }
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
    if (!window.confirm("Xóa buổi chơi này?")) return;
    await remove(s.id);
    navigate("/sessions");
  };

  const handleMarkComplete = async () => {
    await api.updateSession(s.id, { status: "completed" } as any);
    await refresh(s.id);
  };

  const totalCost = s.costs.reduce((sum, cost) => sum + cost.amount, 0);

  const buildQrUrl = (paymentId: string, debtor: Member, recipient: Member, amount: number) => {
    if (!recipient.user_bank_bin || !recipient.user_bank_account_number || !recipient.user_bank_account_name) return null;
    if (amount <= 0 || debtor.id === recipient.id) return null;
    const note = `CLD-${paymentId} ${debtor.name} ${formatDate(s.date)}`;
    return `https://img.vietqr.io/image/${recipient.user_bank_bin}-${recipient.user_bank_account_number}-compact.png?amount=${Math.ceil(amount)}&addInfo=${encodeURIComponent(note)}&accountName=${encodeURIComponent(recipient.user_bank_account_name)}`;
  };

  const canTogglePaymentRow = (payment: Payment, debtor: Member | null, recipient: Member | null) => {
    if (payment.paid) return false;
    if (!currentUserId) return false;
    if (debtor?.user_id === currentUserId) return payment.payer_marked_paid !== 1;
    if (recipient?.user_id === currentUserId) return payment.payer_marked_paid === 1;
    return false;
  };

  const getPaymentActionLabel = (payment: Payment, debtor: Member | null, recipient: Member | null) => {
    const isRecipientUser = Boolean(currentUserId && recipient?.user_id === currentUserId && debtor?.user_id !== currentUserId);
    const isDebtorUser = Boolean(currentUserId && debtor?.user_id === currentUserId);
    if (payment.paid) return isRecipientUser ? "Đã nhận ✓" : "Đã xong ✓";
    if (isRecipientUser) return payment.payer_marked_paid ? "Xác nhận đã nhận" : "Chờ người trả";
    if (isDebtorUser) return payment.payer_marked_paid ? "Chờ xác nhận" : "Đánh dấu đã trả";
    return payment.payer_marked_paid ? "Chờ xác nhận" : "Chưa trả";
  };

  const copyNotification = async () => {
    const costBreakdown = s.costs.length > 0
      ? s.costs.map((cost) => `${cost.label}: ${formatCurrency(cost.amount)}`).join(" | ")
      : "Chưa có khoản chi";
    const paymentLines = paymentRows.length > 0
      ? paymentRows.map(({ payment, debtor, recipient }) => {
        const debtorName = debtor?.name ?? payment.member_id;
        const recipientName = recipient?.name ?? payment.recipient_member_id ?? "người nhận";
        const status = payment.paid
          ? " (đã xong)"
          : payment.payer_marked_paid
            ? " (chờ người nhận xác nhận)"
            : "";
        return `- ${debtorName} -> ${recipientName}: ${formatCurrency(payment.amount_owed)}${status}`;
      }).join("\n")
      : "- Chưa tính tiền";

    const text = [
      `Buổi chơi ${formatDate(s.date)} tại ${s.venue}`,
      `Địa điểm: ${s.location ?? "-"}`,
      `Tham gia: ${s.members.map((member) => member.name).join(", ")}`,
      "",
      `Chi phí: ${costBreakdown}`,
      "",
      "Cần chuyển:",
      paymentLines,
    ].join("\n");

    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const creatorName = s.members.find((member) => member.user_id === s.created_by)?.name ?? "Ẩn danh";

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
            {s.status === "upcoming" ? "Sắp tới" : "Hoàn thành"}
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
          Đánh dấu hoàn thành
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
          {joining ? "Đang xử lý..." : hasJoined ? "Rời buổi" : "Tham gia"}
        </Button>
        <Button variant="outline" onClick={handleShare} className="w-full">
          {shareCopied ? <Check size={16} className="mr-2 text-green-600" /> : <Share2 size={16} className="mr-2" />}
          {shareCopied ? "Đã copy" : "Chia sẻ"}
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
              Cài đặt quản lý
            </button>
          ) : (
            <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <div className="text-xs font-semibold text-gray-700">Người tạo: {creatorName}</div>

              {managersList.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-gray-500">Đồng quản lý:</div>
                  <div className="flex flex-wrap gap-2">
                    {managersList.map((userId) => {
                      const managerMember = s.members.find((member) => member.user_id === userId);
                      if (!managerMember) return null;
                      return (
                        <Badge key={userId} variant="gray" className="flex items-center gap-1">
                          {managerMember.name}
                          <button
                            onClick={async () => {
                              if (!window.confirm(`Xóa quyền quản lý của ${managerMember.name}?`)) return;
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
                    Chọn thành viên
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
                  Thêm
                </Button>
                <Button
                  size="sm"
                  disabled={managingSettings}
                  onClick={async () => {
                    const selectedId = (document.getElementById("manager-select") as HTMLSelectElement | null)?.value;
                    if (!selectedId) return;
                    if (!window.confirm("Chuyển quyền sở hữu buổi chơi này?")) return;
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
                  Chuyển giao
                </Button>
              </div>

              <button
                onClick={() => setShowManagerSettings(false)}
                className="mt-2 w-full text-center text-xs text-gray-500 hover:text-gray-700"
              >
                Đóng
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

      {tab === "Điểm danh" && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-gray-500">{s.members.length} người tham gia</span>
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

      {tab === "Chi phí" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExportCosts} className="flex-1">
              <Download size={14} className="mr-1" />
              Xuất Excel
            </Button>
            {canManageSession && (
              <>
                <input
                  ref={costImportInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleImportCosts}
                  className="hidden"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => costImportInputRef.current?.click()}
                  disabled={importingCosts}
                  className="flex-1"
                >
                  <Upload size={14} className="mr-1" />
                  {importingCosts ? "Đang nhập..." : "Nhập Excel"}
                </Button>
              </>
            )}
          </div>

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
                  onChange={(event) => {
                    const raw = event.target.value;
                    const parsed = parseInt(raw, 10);
                    setCostForm((current) => ({
                      ...current,
                      amount: Number.isFinite(parsed) && parsed > 0 ? String(parsed) : raw.replace(/[^\d]/g, ""),
                    }));
                  }}
                  placeholder="Số tiền (VNĐ)"
                  type="number"
                  min="0"
                  step="1"
                />
              </div>

              <Input
                value={costForm.label}
                onChange={(event) => setCostForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="Mô tả"
              />

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Người ứng tiền</label>
                  <select
                    value={costForm.payerId}
                    onChange={(event) => setCostForm((current) => ({ ...current, payerId: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Người nhận chung</option>
                    {s.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Người dùng riêng</label>
                  <select
                    value={costForm.consumerPending ? "__pending__" : (costForm.consumerId || "")}
                    onChange={(event) => {
                      const val = event.target.value;
                      if (val === "__pending__") {
                        setCostForm((current) => ({ ...current, consumerId: "", consumerPending: 1 }));
                      } else {
                        setCostForm((current) => ({ ...current, consumerId: val, consumerPending: 0 }));
                      }
                    }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Dùng chung</option>
                    <option value="__pending__">Chưa rõ</option>
                    {s.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={handleSaveCost} disabled={addingCost || !costForm.label || !costForm.amount}>
                  {editingCostId ? <Check size={16} className="mr-1" /> : <Plus size={16} className="mr-1" />}
                  {addingCost
                    ? (editingCostId ? "Đang lưu..." : "Đang thêm...")
                    : (editingCostId ? "Lưu khoản chi" : "Thêm khoản chi")}
                </Button>
                {editingCostId && (
                  <Button variant="outline" size="icon" onClick={resetCostForm} disabled={addingCost}>
                    <X size={16} />
                  </Button>
                )}
              </div>
            </div>
          )}

          {s.costs.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Chưa có khoản chi nào</div>
          ) : (
            <div className="space-y-2">
              {s.costs.map((cost) => {
                const payerMember = cost.payer_id ? memberById.get(cost.payer_id) ?? null : null;
                const consumerMember = cost.consumer_id ? memberById.get(cost.consumer_id) ?? null : null;

                let helperText = "Trả cho người nhận chung";
                let helperClass = "text-green-500";
                if (cost.consumer_pending) {
                  helperText = "Chưa rõ ai dùng — chưa tính vào chia tiền";
                  helperClass = "text-amber-500";
                } else if (payerMember && consumerMember) {
                  helperText = `${consumerMember.name} trả lại cho ${payerMember.name}`;
                  helperClass = "text-orange-500";
                } else if (consumerMember) {
                  helperText = `${consumerMember.name} trả lại cho người nhận chung`;
                  helperClass = "text-orange-500";
                } else if (payerMember) {
                  helperText = `Cả nhóm trả lại cho ${payerMember.name}`;
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
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleStartEditCost(cost)}
                            className="text-gray-400 hover:text-gray-700"
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteCost(cost.id)}
                            className="text-red-400 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 p-3">
                <span className="font-semibold text-green-800">Tổng cộng</span>
                <span className="font-bold text-green-800">{formatCurrency(totalCost)}</span>
              </div>
            </div>
          )}

          {canManageSession && s.costs.length > 0 && s.members.length > 0 && (
            <>
              {membersWithBank.length > 0 && (
                <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-3">
                  <label className="block text-xs text-gray-500">Người nhận chung / dự phòng</label>
                  <select
                    value={recipientId}
                    onChange={(event) => handleSetRecipient(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">-- Chưa chọn --</option>
                    {membersWithBank.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                  <div className="text-xs text-gray-500">
                    QR sẽ ưu tiên hiện theo người ứng tiền. Nếu người đó chưa cập nhật STK, hệ thống mới dùng người nhận chung này.
                  </div>
                </div>
              )}

              <Button variant="outline" className="w-full" onClick={handleRecalculate} disabled={recalculating}>
                <RefreshCw size={16} className={`mr-2 ${recalculating ? "animate-spin" : ""}`} />
                {recalculating ? "Đang tính..." : "Tính lại và cập nhật"}
              </Button>
            </>
          )}
        </div>
      )}

      {tab === "Thanh toán" && (
        <div className="space-y-3">
          <Button variant="outline" size="sm" onClick={copyNotification} className="w-full">
            {copied ? (
              <>
                <Check size={14} className="mr-1 text-green-600" />
                Đã copy
              </>
            ) : (
              <>
                <Copy size={14} className="mr-1" />
                Copy thông báo
              </>
            )}
          </Button>

          {paymentRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Chưa tính tiền. Vào tab Chi phí để tính lại.</div>
          ) : (
            <div className="space-y-2">
              {paymentRows.map(({ payment, debtor, recipient }) => {
                const debtorName = debtor?.name ?? payment.member_id;
                const recipientName = recipient?.name ?? payment.recipient_member_id ?? "người nhận";
                const recipientHasBank = hasBankInfo(recipient);
                const qrRecipient = recipientHasBank
                  ? recipient
                  : (fallbackRecipientMember && fallbackRecipientMember.id !== payment.member_id ? fallbackRecipientMember : null);
                const canViewQr = Boolean(currentUserId && debtor?.user_id === currentUserId);
                const qrUrl = canViewQr && debtor && qrRecipient ? buildQrUrl(payment.id, debtor, qrRecipient, payment.amount_owed) : null;
                const fallbackNotice = !recipientHasBank && qrRecipient && recipient
                  ? `Người ứng tiền chưa cập nhật STK, tạm chuyển qua ${qrRecipient.name}.`
                  : null;
                const pendingNotice = payment.payer_marked_paid && !payment.paid
                  ? `${debtorName} đã báo đã trả, chờ ${recipientName} xác nhận đã nhận.`
                  : null;
                const toggleAllowed = canTogglePaymentRow(payment, debtor, recipient);
                const showMissingQrNotice = canViewQr && !qrUrl && !payment.paid;

                return (
                  <div
                    key={payment.id}
                    className={`rounded-xl border p-3 transition-colors ${payment.paid
                      ? "border-green-200 bg-green-50"
                      : payment.payer_marked_paid
                        ? "border-amber-200 bg-amber-50"
                        : "border-gray-100 bg-white"
                      }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {debtor && <Avatar name={debtor.name} color={debtor.avatar_color} size="sm" />}
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{debtorName}</div>
                          <div className="text-sm text-gray-500">Trả cho {recipientName}</div>
                          <div className="mt-0.5 text-sm font-semibold text-gray-800">
                            {formatCurrency(payment.amount_owed)}
                          </div>
                          {fallbackNotice && (
                            <div className="mt-1 text-xs text-amber-600">{fallbackNotice}</div>
                          )}
                          {pendingNotice && (
                            <div className="mt-1 text-xs text-amber-700">{pendingNotice}</div>
                          )}
                          {showMissingQrNotice && (
                            <div className="mt-1 text-xs text-red-500">Chưa có tài khoản nhận tiền để tạo QR.</div>
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
                        {getPaymentActionLabel(payment, debtor, recipient)}
                      </button>
                    </div>

                    {qrUrl && !payment.paid && (
                      <div className="mt-3 flex flex-col items-center gap-2">
                        <img
                          src={qrUrl}
                          alt={`QR chuyển khoản cho ${qrRecipient?.name ?? recipientName}`}
                          className="h-auto w-48 rounded-lg border border-gray-200"
                          loading="lazy"
                        />
                        <div className="text-center text-xs text-gray-500">
                          QR nhận tiền: {qrRecipient?.name ?? recipientName}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="space-y-1 rounded-xl bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Đã xong</span>
                  <span className="text-sm font-medium text-gray-900">
                    {paymentRows.filter(({ payment }) => payment.paid).length}/{paymentRows.length} giao dịch
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Chờ xác nhận</span>
                  <span className="text-sm font-medium text-gray-900">
                    {paymentRows.filter(({ payment }) => payment.payer_marked_paid && !payment.paid).length}/{paymentRows.length} giao dịch
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Tổng cần chuyển</span>
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
