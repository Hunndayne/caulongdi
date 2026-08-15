import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BellRing,
  Bot,
  Check,
  Copy,
  Landmark,
  Link2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserCircle,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import { useSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/permissions";
import { cn, formatCurrency } from "@/lib/utils";
import { useGroupsStore } from "@/stores/groupsStore";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/EmptyState";
import type { GroupBotAgent, GroupDebtReminder, GroupInvite, GroupMember, GroupPaymentSettings, GroupSearchResult } from "@/types";
import banksData from "@/lib/banks.json";

const banks = (banksData as any).data.filter((b: any) => b.transferSupported === 1);

const TIMO_OUTCOME_LABELS: Record<string, { label: string; className: string }> = {
  confirmed: { label: "Đã xác nhận", className: "text-green-600" },
  already_paid: { label: "Đã trả trước đó", className: "text-gray-500" },
  no_payment_code: { label: "Không có mã TingTing", className: "text-gray-400" },
  not_incoming: { label: "Tiền ra khỏi hũ", className: "text-gray-400" },
  amount_mismatch: { label: "Lệch số tiền", className: "text-orange-600" },
  not_pot_session: { label: "Buổi không thu về nhóm", className: "text-orange-600" },
  not_found: { label: "Không tìm thấy payment", className: "text-orange-600" },
  wrong_group: { label: "Payment thuộc nhóm khác", className: "text-orange-600" },
  recipient_not_eligible: { label: "Người nhận không hợp lệ", className: "text-orange-600" },
  pending: { label: "Đang xử lý", className: "text-gray-500" },
};

// Backend có thể thêm outcome mới — không map được thì hiện thẳng giá trị gốc.
function timoOutcomeLabel(outcome: string) {
  return TIMO_OUTCOME_LABELS[outcome] ?? { label: outcome, className: "text-gray-500" };
}

function formatTimoTime(value: string | null) {
  if (!value) return "chưa có";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MembersPage() {
  const { data: session } = useSession();
  const {
    groups,
    activeGroupId,
    loading: loadingGroups,
    error: groupError,
    fetch: fetchGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    setActiveGroup,
  } = useGroupsStore();

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [receivedInvites, setReceivedInvites] = useState<GroupInvite[]>([]);
  const [pendingInvites, setPendingInvites] = useState<GroupInvite[]>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<GroupSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [actingInviteId, setActingInviteId] = useState<string | null>(null);
  const [actingUserId, setActingUserId] = useState<string | null>(null);
  const [inviteLinkCode, setInviteLinkCode] = useState<string | null>(null);
  const [inviteLinkLoading, setInviteLinkLoading] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [botLinkCode, setBotLinkCode] = useState<string | null>(null);
  const [botLinkExpiresAt, setBotLinkExpiresAt] = useState<string | null>(null);
  const [botLinkLoading, setBotLinkLoading] = useState(false);
  const [botLinkCopied, setBotLinkCopied] = useState(false);
  const [timoPot, setTimoPot] = useState<GroupPaymentSettings | null>(null);
  const [debtReminder, setDebtReminder] = useState<GroupDebtReminder | null>(null);
  const [debtReminderTime, setDebtReminderTime] = useState("20:00");
  const [debtReminderSaving, setDebtReminderSaving] = useState(false);
  const [botAgent, setBotAgent] = useState<GroupBotAgent | null>(null);
  const [botAgentSaving, setBotAgentSaving] = useState(false);
  const [groupBankBin, setGroupBankBin] = useState("");
  const [groupBankAccountNumber, setGroupBankAccountNumber] = useState("");
  const [groupBankAccountName, setGroupBankAccountName] = useState("");
  const [timoShareUrl, setTimoShareUrl] = useState("");
  const [timoPasscode, setTimoPasscode] = useState("");
  const [timoSaving, setTimoSaving] = useState(false);
  const [timoChecking, setTimoChecking] = useState(false);
  const [timoDeleting, setTimoDeleting] = useState(false);
  const [timoNotice, setTimoNotice] = useState<string | null>(null);
  const [timoWarning, setTimoWarning] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);

  const currentUserId = (session?.user as { id?: string } | undefined)?.id;
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId),
    [groups, activeGroupId]
  );
  const canManageGroup = activeGroup?.role === "admin";
  const canDeleteGroup = Boolean(
    activeGroup && (activeGroup.ownerUserId === currentUserId || isAdminUser(session?.user))
  );

  useEffect(() => {
    fetchGroups();
    api.getReceivedGroupInvites().then(setReceivedInvites).catch(() => {});
  }, [fetchGroups]);

  useEffect(() => {
    if (!activeGroupId) {
      setMembers([]);
      setPendingInvites([]);
      setInviteLinkCode(null);
    }
    // Mã bot thuộc về nhóm cụ thể — đổi nhóm là bỏ mã đang hiện
    setBotLinkCode(null);
    setBotLinkExpiresAt(null);
    // Cài đặt thanh toán cũng theo nhóm — tránh hiện dữ liệu của nhóm trước
    setTimoPot(null);
    setDebtReminder(null);
    setDebtReminderTime("20:00");
    setBotAgent(null);
    setGroupBankBin("");
    setGroupBankAccountNumber("");
    setGroupBankAccountName("");
    setTimoShareUrl("");
    setTimoPasscode("");
    setTimoNotice(null);
    setTimoWarning(null);
    if (!activeGroupId) return;

    setMembersLoading(true);
    api.getGroupMembers(activeGroupId)
      .then(setMembers)
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được thành viên"))
      .finally(() => setMembersLoading(false));

    if (!canManageGroup) {
      setPendingInvites([]);
      return;
    }

    api.getGroupInvites(activeGroupId)
      .then(setPendingInvites)
      .catch((err) => setError(err instanceof Error ? err.message : "Không tải được lời mời"));

    // Nuốt lỗi: cài đặt phụ, hỏng thì cũng không nên chắn cả trang thành viên.
    api.getDebtReminder(activeGroupId)
      .then((settings) => {
        setDebtReminder(settings);
        setDebtReminderTime(settings.time);
      })
      .catch(() => {});

    api.getBotAgent(activeGroupId)
      .then(setBotAgent)
      .catch(() => {});
  }, [activeGroupId, canManageGroup]);

  useEffect(() => {
    if (!activeGroupId || !canManageGroup || search.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      api.searchGroupUsers(activeGroupId, search.trim())
        .then(setSearchResults)
        .catch((err) => setError(err instanceof Error ? err.message : "Không tìm được user"))
        .finally(() => setSearchLoading(false));
    }, 250);

    return () => window.clearTimeout(timer);
  }, [activeGroupId, canManageGroup, search]);

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return;

    setCreatingGroup(true);
    setError(null);
    try {
      await createGroup({
        name: groupName.trim(),
        description: groupDescription.trim() || undefined,
      });
      setGroupName("");
      setGroupDescription("");
      setCreateDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tạo được nhóm");
    } finally {
      setCreatingGroup(false);
    }
  };

  const refreshReceivedInvites = async () => {
    try {
      const invites = await api.getReceivedGroupInvites();
      setReceivedInvites(invites);
    } catch {}
  };

  const handleAcceptInvite = async (inviteId: string) => {
    setActingInviteId(inviteId);
    setError(null);
    try {
      const result = await api.acceptGroupInvite(inviteId);
      await fetchGroups();
      setActiveGroup(result.groupId);
      await refreshReceivedInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không chấp nhận được lời mời");
    } finally {
      setActingInviteId(null);
    }
  };

  const handleDeclineInvite = async (inviteId: string) => {
    setActingInviteId(inviteId);
    setError(null);
    try {
      await api.declineGroupInvite(inviteId);
      await refreshReceivedInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không từ chối được lời mời");
    } finally {
      setActingInviteId(null);
    }
  };

  const handleInviteUser = async (user: GroupSearchResult) => {
    if (!activeGroupId) return;

    setActingUserId(user.userId);
    setError(null);
    try {
      const invite = await api.inviteGroupMember(activeGroupId, {
        userId: user.userId,
        role: inviteRole,
      });
      setPendingInvites((current) => [invite, ...current.filter((item) => item.id !== invite.id)]);
      setSearchResults((current) =>
        current.map((item) =>
          item.userId === user.userId
            ? { ...item, inviteStatus: "pending", pendingInviteId: invite.id }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được lời mời");
    } finally {
      setActingUserId(null);
    }
  };

  const handleCancelInvite = async (invite: GroupInvite) => {
    setActingInviteId(invite.id);
    setError(null);
    try {
      await api.cancelGroupInvite(invite.groupId, invite.id);
      setPendingInvites((current) => current.filter((item) => item.id !== invite.id));
      setSearchResults((current) =>
        current.map((item) =>
          item.userId === invite.invitedUserId
            ? { ...item, inviteStatus: "none", pendingInviteId: undefined }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không hủy được lời mời");
    } finally {
      setActingInviteId(null);
    }
  };

  const handleCreateBotLinkCode = async () => {
    if (!activeGroupId) return;
    setBotLinkLoading(true);
    setError(null);
    try {
      const result = await api.createBotLinkCode(activeGroupId);
      setBotLinkCode(result.code);
      setBotLinkExpiresAt(result.expiresAt);
      setBotLinkCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tạo được mã liên kết bot");
    } finally {
      setBotLinkLoading(false);
    }
  };

  const handleSaveDebtReminder = async (enabled: boolean, time: string) => {
    if (!activeGroupId) return;
    setDebtReminderSaving(true);
    setError(null);
    try {
      const saved = await api.saveDebtReminder(activeGroupId, { enabled, time });
      setDebtReminder(saved);
      setDebtReminderTime(saved.time);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được cài đặt nhắc công nợ");
    } finally {
      setDebtReminderSaving(false);
    }
  };

  const handleSaveBotAgent = async (enabled: boolean) => {
    if (!activeGroupId) return;
    setBotAgentSaving(true);
    setError(null);
    try {
      const saved = await api.saveBotAgent(activeGroupId, enabled);
      setBotAgent(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được cài đặt chatbot AI");
    } finally {
      setBotAgentSaving(false);
    }
  };

  const refreshTimoPot = async (groupId: string) => {
    try {
      setTimoPot(await api.getPaymentSettings(groupId));
    } catch {}
  };

  const handleSaveTimoPot = async () => {
    if (!activeGroupId) return;

    setTimoSaving(true);
    setError(null);
    setTimoNotice(null);
    setTimoWarning(null);
    try {
      const payload: { bankBin?: string; bankAccountNumber?: string; bankAccountName?: string; shareUrl?: string; passcode?: string } = {
        bankBin: groupBankBin,
        bankAccountNumber: groupBankAccountNumber.trim(),
        bankAccountName: groupBankAccountName.trim(),
      };
      // Chỉ gửi shareUrl khi ô có nội dung — gửi "" nhầm sẽ bỏ mất hũ đang có
      if (timoShareUrl.trim()) payload.shareUrl = timoShareUrl.trim();
      if (timoPasscode.trim()) payload.passcode = timoPasscode.trim();

      const settings = await api.savePaymentSettings(activeGroupId, payload);
      setTimoPot(settings);
      setGroupBankBin(settings.bankBin ?? "");
      setGroupBankAccountNumber(settings.bankAccountNumber ?? "");
      setGroupBankAccountName(settings.bankAccountName ?? "");
      setTimoShareUrl(settings.timo.shareUrl ?? "");
      setTimoPasscode("");
      setTimoWarning(settings.warning ?? null);
      setTimoNotice(
        typeof settings.txnCount === "number"
          ? `Đã lưu, đọc thử được ${settings.txnCount} giao dịch.`
          : "Đã lưu thông tin thanh toán."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được cài đặt thanh toán");
    } finally {
      setTimoSaving(false);
    }
  };

  const handleCheckTimoPot = async () => {
    if (!activeGroupId) return;

    setTimoChecking(true);
    setError(null);
    setTimoNotice(null);
    try {
      const result = await api.checkPotNow(activeGroupId);
      setTimoNotice(
        result.throttled
          ? "Vừa quét xong, thử lại sau vài giây."
          : `Đã quét ${result.scanned ?? 0} giao dịch, xác nhận ${result.confirmed ?? 0}.`
      );
      await refreshTimoPot(activeGroupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không quét được hũ Timo");
    } finally {
      setTimoChecking(false);
    }
  };

  const handleDeleteTimoPot = async () => {
    if (!activeGroupId) return;
    if (!confirm("Bỏ liên kết hũ Timo? Nhóm sẽ không còn tự xác nhận thanh toán.")) return;

    setTimoDeleting(true);
    setError(null);
    try {
      const settings = await api.savePaymentSettings(activeGroupId, { shareUrl: "" });
      setTimoPot(settings);
      setTimoShareUrl("");
      setTimoPasscode("");
      setTimoWarning(null);
      setTimoNotice("Đã bỏ liên kết hũ Timo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không bỏ được liên kết hũ Timo");
    } finally {
      setTimoDeleting(false);
    }
  };

  const handleRemoveMember = async (member: GroupMember) => {
    if (!activeGroupId) return;
    if (!confirm(`Xóa ${member.name} khỏi nhóm ${activeGroup?.name}?`)) return;

    setActingUserId(member.userId);
    setError(null);
    try {
      await api.removeGroupMember(activeGroupId, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      await fetchGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không xóa được thành viên");
    } finally {
      setActingUserId(null);
    }
  };

  const handleDeleteGroup = async () => {
    if (!activeGroup) return;
    const confirmed = confirm(
      `Xóa nhóm "${activeGroup.name}"? Tất cả buổi chơi, thành viên, chi phí và lời mời trong nhóm sẽ bị xóa.`
    );
    if (!confirmed) return;

    setDeletingGroup(true);
    setError(null);
    try {
      await deleteGroup(activeGroup.id);
      setMembers([]);
      setPendingInvites([]);
      setSearch("");
      setSearchResults([]);
      setInviteLinkCode(null);
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không xóa được nhóm");
    } finally {
      setDeletingGroup(false);
    }
  };

  const openSettings = () => {
    setEditName(activeGroup?.name ?? "");
    setEditDescription(activeGroup?.description ?? "");
    setTimoPasscode("");
    setTimoNotice(null);
    setTimoWarning(null);
    setSettingsOpen(true);

    if (!activeGroupId || !canManageGroup) return;
    // Chỉ admin nhóm đọc được; 403 hoặc lỗi mạng thì bỏ qua êm
    api.getPaymentSettings(activeGroupId)
      .then((settings) => {
        setTimoPot(settings);
        setGroupBankBin(settings.bankBin ?? "");
        setGroupBankAccountNumber(settings.bankAccountNumber ?? "");
        setGroupBankAccountName(settings.bankAccountName ?? "");
        setTimoShareUrl(settings.timo.shareUrl ?? "");
      })
      .catch(() => {});
  };

  const handleSaveGroupInfo = async () => {
    if (!activeGroup || !editName.trim()) return;
    setSavingGroup(true);
    setError(null);
    try {
      await updateGroup(activeGroup.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      });
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được thông tin nhóm");
    } finally {
      setSavingGroup(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <UserCircle size={20} className="text-green-600" />
        <h1 className="text-xl font-bold text-gray-900">Thành viên và nhóm</h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-gray-900">Nhóm hiện tại</div>
            <div className="text-sm text-gray-500">Chỉ thành viên trong nhóm mới xem được nhau.</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus size={16} className="mr-1.5" />
              Tạo nhóm
            </Button>
            {activeGroup && (canManageGroup || canDeleteGroup) && (
              <Button variant="outline" size="icon" onClick={openSettings} aria-label="Cài đặt nhóm">
                <Settings size={16} />
              </Button>
            )}
          </div>
        </div>

        <select
          value={activeGroupId ?? ""}
          onChange={(event) => setActiveGroup(event.target.value || undefined)}
          disabled={loadingGroups || groups.length === 0}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          {groups.length === 0 ? (
            <option value="">Chưa có nhóm nào</option>
          ) : (
            groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))
          )}
        </select>

        {(groupError || activeGroup?.description) && (
          <div className="text-sm text-gray-500">
            {groupError ?? activeGroup?.description}
          </div>
        )}
      </section>

      {receivedInvites.length > 0 && (
        <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <Mail size={18} className="text-green-600" />
            <h2 className="font-semibold text-gray-900">Lời mời đang chờ bạn xác nhận</h2>
          </div>
          <div className="space-y-2">
            {receivedInvites.map((invite) => (
              <div key={invite.id} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900">{invite.groupName}</div>
                    <div className="text-sm text-gray-500">
                      Mời bởi {invite.invitedByName} ({invite.invitedByEmail})
                    </div>
                  </div>
                  <Badge variant={invite.role === "admin" ? "green" : "gray"}>
                    {invite.role === "admin" ? "Mời làm admin" : "Mời vào nhóm"}
                  </Badge>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleAcceptInvite(invite.id)}
                    disabled={actingInviteId === invite.id}
                  >
                    <Check size={15} className="mr-1.5" />
                    Chấp nhận
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDeclineInvite(invite.id)}
                    disabled={actingInviteId === invite.id}
                  >
                    <X size={15} className="mr-1.5" />
                    Từ chối
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeGroup && canManageGroup && (
        <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-green-600" />
            <h2 className="font-semibold text-gray-900">Mời thêm thành viên</h2>
          </div>

          {/* Invite by link */}
          <div className="rounded-lg border border-green-100 bg-green-50/50 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <Link2 size={15} className="text-green-600" />
              Mời bằng link
            </div>
            {inviteLinkCode ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={`${window.location.origin}/join/${inviteLinkCode}`}
                    className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 select-all focus:outline-none focus:ring-2 focus:ring-green-500"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    size="sm"
                    variant={inviteLinkCopied ? "default" : "outline"}
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/join/${inviteLinkCode}`);
                      setInviteLinkCopied(true);
                      setTimeout(() => setInviteLinkCopied(false), 2000);
                    }}
                  >
                    {inviteLinkCopied ? (
                      <><Check size={14} className="mr-1" />Đã copy</>
                    ) : (
                      <><Copy size={14} className="mr-1" />Copy</>  
                    )}
                  </Button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">Ai có link đều có thể tham gia nhóm</span>
                  <button
                    className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1"
                    onClick={async () => {
                      if (!activeGroupId) return;
                      try {
                        await api.revokeInviteLink(activeGroupId);
                        setInviteLinkCode(null);
                      } catch {}
                    }}
                  >
                    <RefreshCw size={11} />
                    Tạo link mới
                  </button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={inviteLinkLoading}
                onClick={async () => {
                  if (!activeGroupId) return;
                  setInviteLinkLoading(true);
                  try {
                    const link = await api.createInviteLink(activeGroupId);
                    setInviteLinkCode(link.code);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Không tạo được link mời");
                  } finally {
                    setInviteLinkLoading(false);
                  }
                }}
              >
                <Link2 size={15} className="mr-1.5" />
                {inviteLinkLoading ? "Đang tạo..." : "Tạo link mời"}
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Tìm theo tên hoặc email"
              />
            </div>
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as "admin" | "member")}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          {search.trim().length < 2 ? (
            <div className="text-sm text-gray-500">Nhập ít nhất 2 ký tự để tìm user.</div>
          ) : searchLoading ? (
            <div className="text-sm text-gray-500">Đang tìm user...</div>
          ) : searchResults.length === 0 ? (
            <div className="text-sm text-gray-500">Không tìm thấy user phù hợp.</div>
          ) : (
            <div className="space-y-2">
              {searchResults.map((user) => (
                <div key={user.userId} className="flex items-center gap-3 rounded-xl border border-gray-100 p-3">
                  <Avatar name={user.name} color="#16a34a" imageUrl={user.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">{user.name}</div>
                    <div className="text-xs text-gray-500 truncate">{user.email}</div>
                  </div>
                  <Button
                    size="sm"
                    variant={user.inviteStatus === "pending" ? "outline" : "default"}
                    onClick={() => handleInviteUser(user)}
                    disabled={actingUserId === user.userId || user.inviteStatus === "pending"}
                  >
                    {user.inviteStatus === "pending" ? "Đã mời" : "Gửi lời mời"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeGroup && canManageGroup && pendingInvites.length > 0 && (
        <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <Mail size={18} className="text-green-600" />
            <h2 className="font-semibold text-gray-900">Lời mời đang chờ</h2>
          </div>
          <div className="space-y-2">
            {pendingInvites.map((invite) => (
              <div key={invite.id} className="flex items-center gap-3 rounded-xl border border-gray-100 p-3">
                <Avatar
                  name={invite.invitedUserName || invite.invitedUserEmail || "User"}
                  color="#16a34a"
                  imageUrl={invite.invitedUserAvatarUrl}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900 truncate">
                    {invite.invitedUserName || invite.invitedUserEmail || "User"}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {invite.invitedUserEmail ?? "Đang chờ xác nhận"}
                  </div>
                </div>
                <Badge variant={invite.role === "admin" ? "green" : "gray"}>
                  {invite.role === "admin" ? "Admin" : "Member"}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-500 hover:bg-red-50 hover:text-red-600"
                  onClick={() => handleCancelInvite(invite)}
                  disabled={actingInviteId === invite.id}
                  aria-label="Hủy lời mời"
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-green-600" />
          <h2 className="font-semibold text-gray-900">
            {activeGroup ? `Thành viên trong ${activeGroup.name}` : "Thành viên trong nhóm"}
          </h2>
        </div>

        {!activeGroup ? (
          <EmptyState
            icon="👥"
            title="Chưa chọn nhóm"
            description="Tạo nhóm mới hoặc chấp nhận một lời mời để bắt đầu."
          />
        ) : membersLoading ? (
          <div className="text-center py-12 text-gray-400">Đang tải thành viên...</div>
        ) : members.length === 0 ? (
          <EmptyState
            icon="👥"
            title="Chưa có thành viên"
            description="Thêm thành viên bằng lời mời, họ sẽ vào nhóm sau khi chấp nhận."
          />
        ) : (
          <div className="space-y-2">
            {members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white p-3 shadow-sm"
              >
                <Link to={`/profiles/${member.userId}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={member.name} color="#16a34a" imageUrl={member.avatarUrl} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-medium text-gray-900">{member.name}</span>
                      {member.role === "admin" && (
                        <Badge variant="green" className="inline-flex">
                          <ShieldCheck size={12} className="mr-1" />
                          Admin
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-500 truncate">
                      <Mail size={11} className="flex-shrink-0" />
                      <span className="truncate">{member.email}</span>
                    </div>
                  </div>
                </Link>

                {canManageGroup && member.userId !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-500 hover:bg-red-50 hover:text-red-600"
                    onClick={() => handleRemoveMember(member)}
                    disabled={actingUserId === member.userId}
                    aria-label="Xóa khỏi nhóm"
                  >
                    <UserMinus size={16} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title={`Cài đặt nhóm${activeGroup ? ` «${activeGroup.name}»` : ""}`}>
        <div className="space-y-5">
          {canManageGroup && (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-gray-900">Thông tin nhóm</div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Tên nhóm *</label>
                <Input value={editName} onChange={(event) => setEditName(event.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Mô tả</label>
                <Input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
              </div>
              <Button size="sm" onClick={handleSaveGroupInfo} disabled={savingGroup || !editName.trim()}>
                {savingGroup ? "Đang lưu..." : "Lưu thay đổi"}
              </Button>
            </div>
          )}

          {canManageGroup && (
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Bot size={16} className="text-green-600" />
                Kết nối Messenger
              </div>
              <p className="text-xs text-gray-500">
                Liên kết nhóm với group chat Messenger có bot TingTing: tạo mã rồi gõ{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-gray-700">/connect &lt;mã&gt;</code>{" "}
                trong group chat.
              </p>
              {botLinkCode ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1 min-w-0 select-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center font-mono text-2xl tracking-[0.3em] text-gray-900">
                      {botLinkCode}
                    </div>
                    <Button
                      size="sm"
                      variant={botLinkCopied ? "default" : "outline"}
                      onClick={() => {
                        navigator.clipboard.writeText(`/connect ${botLinkCode}`);
                        setBotLinkCopied(true);
                        setTimeout(() => setBotLinkCopied(false), 2000);
                      }}
                    >
                      {botLinkCopied ? (
                        <><Check size={14} className="mr-1" />Đã copy</>
                      ) : (
                        <><Copy size={14} className="mr-1" />Copy lệnh</>
                      )}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      Mã dùng 1 lần
                      {botLinkExpiresAt &&
                        `, hết hạn lúc ${new Date(botLinkExpiresAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`}
                    </span>
                    <button
                      className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700"
                      onClick={handleCreateBotLinkCode}
                      disabled={botLinkLoading}
                    >
                      <RefreshCw size={11} />
                      Tạo mã mới
                    </button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={botLinkLoading}
                  onClick={handleCreateBotLinkCode}
                >
                  <Bot size={15} className="mr-1.5" />
                  {botLinkLoading ? "Đang tạo..." : "Tạo mã liên kết"}
                </Button>
              )}
            </div>
          )}

          {canManageGroup && (
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <BellRing size={16} className="text-green-600" />
                Nhắc công nợ qua Messenger
              </div>
              <p className="text-xs text-gray-500">
                Mỗi ngày vào giờ đã đặt, bot đăng vào group chat danh sách ai còn nợ bao nhiêu.
                Cả nhóm sạch nợ thì bot im lặng, không nhắn gì.
              </p>
              {debtReminder && !debtReminder.messengerLinked && (
                <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-700">
                  Nhóm chưa liên kết group chat Messenger nên bật cũng chưa có nơi nhận tin — làm ở
                  mục "Kết nối Messenger" phía trên trước nhé.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="time"
                  value={debtReminderTime}
                  onChange={(event) => setDebtReminderTime(event.target.value)}
                  className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-900"
                />
                <Button
                  size="sm"
                  variant={debtReminder?.enabled ? "default" : "outline"}
                  disabled={debtReminderSaving}
                  onClick={() => handleSaveDebtReminder(!debtReminder?.enabled, debtReminderTime)}
                >
                  {debtReminderSaving
                    ? "Đang lưu..."
                    : debtReminder?.enabled
                      ? "Đang bật — bấm để tắt"
                      : "Bật nhắc"}
                </Button>
                {debtReminder?.enabled && debtReminderTime !== debtReminder.time && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={debtReminderSaving}
                    onClick={() => handleSaveDebtReminder(true, debtReminderTime)}
                  >
                    Lưu giờ mới
                  </Button>
                )}
              </div>
              {debtReminder?.enabled && (
                <p className="text-xs text-gray-400">
                  Đang nhắc hằng ngày lúc {debtReminder.time} (giờ Việt Nam).
                </p>
              )}
            </div>
          )}

          {canManageGroup && (
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Bot size={16} className="text-green-600" />
                Chatbot AI agent (thử nghiệm)
              </div>
              <p className="text-xs text-gray-500">
                Bật để bot hiểu và xử lý câu tự nhiên bằng AI agent (tự gọi công cụ, làm được yêu
                cầu nhiều bước) thay cho luồng nhận lệnh cứng. Thao tác hủy buổi / xóa khoản chi luôn
                được hỏi xác nhận trước. Tắt thì bot chạy như cũ.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={botAgent?.enabled ? "default" : "outline"}
                  disabled={botAgentSaving || !botAgent}
                  onClick={() => handleSaveBotAgent(!botAgent?.enabled)}
                >
                  {botAgentSaving
                    ? "Đang lưu..."
                    : botAgent?.enabled
                      ? "Đang bật — bấm để tắt"
                      : "Bật chatbot AI"}
                </Button>
              </div>
              {botAgent?.enabled && (
                <p className="text-xs text-gray-400">
                  Bot đang dùng AI agent. Nếu trả lời sai/chậm, tắt đi là quay lại luồng cũ ngay.
                </p>
              )}
            </div>
          )}

          {canManageGroup && (
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Landmark size={16} className="text-green-600" />
                Thanh toán của nhóm
              </div>
              <p className="text-xs text-gray-500">
                Tài khoản nhận tiền CHUNG của nhóm — khác hoàn toàn với tài khoản cá nhân trong trang cá nhân
                (tài khoản cá nhân chỉ dùng khi trưởng nhóm hoàn tiền cho người đã ứng chi phí).
              </p>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Ngân hàng</label>
                <select
                  value={groupBankBin}
                  onChange={(event) => setGroupBankBin(event.target.value)}
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
                <Input
                  value={groupBankAccountNumber}
                  onChange={(event) => setGroupBankAccountNumber(event.target.value)}
                  placeholder="0123456789 hoặc TIMO90C0908A658"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Tên chủ tài khoản</label>
                <Input
                  value={groupBankAccountName}
                  onChange={(event) => setGroupBankAccountName(event.target.value.toUpperCase())}
                  placeholder="NGUYEN VAN A"
                />
                <p className="mt-1 text-xs text-gray-400">In hoa, không dấu</p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Link hũ Timo (không bắt buộc)</label>
                <Input
                  value={timoShareUrl}
                  onChange={(event) => setTimoShareUrl(event.target.value)}
                  placeholder="https://share.timo.vn/VN/transaction/..."
                />
                <p className="mt-1 text-xs text-gray-400">
                  Có link thì hệ thống tự xác nhận khi thành viên chuyển tiền; để trống vẫn dùng tài khoản chung
                  bình thường.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Mật khẩu hũ (không bắt buộc)</label>
                {/* Backend không bao giờ trả mật khẩu về nên ô này luôn để trống */}
                <Input
                  type="password"
                  value={timoPasscode}
                  onChange={(event) => setTimoPasscode(event.target.value)}
                  placeholder="Để trống nếu hũ không đặt mật khẩu"
                />
                {timoPot?.timo.hasSecurityCode && (
                  <div className="mt-1 text-xs text-gray-400">Đã lưu mật khẩu — để trống nếu không đổi</div>
                )}
              </div>
              <Button size="sm" onClick={handleSaveTimoPot} disabled={timoSaving}>
                {timoSaving ? "Đang lưu..." : "Lưu"}
              </Button>

              {(timoWarning || timoPot?.timo.accountMatchesPot === false) && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-medium text-orange-700">
                  {timoWarning ??
                    "Số tài khoản nhóm không phải số riêng của hũ — tiền chuyển vào sẽ không tự xác nhận được."}
                </div>
              )}

              {timoNotice && (
                <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                  {timoNotice}
                </div>
              )}

              {timoPot?.timo.configured && (
                <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <div className="space-y-0.5 text-xs text-gray-600">
                    <div className="text-sm font-medium text-gray-900">{timoPot.timo.potName ?? "Hũ Timo"}</div>
                    {timoPot.timo.ownerName && <div>Chủ hũ: {timoPot.timo.ownerName}</div>}
                    {timoPot.timo.potBankLabel && <div>Ngân hàng: {timoPot.timo.potBankLabel}</div>}
                    {timoPot.timo.potAccount && (
                      <div>
                        Số tài khoản của hũ:{" "}
                        <span className="font-mono text-gray-800">{timoPot.timo.potAccount}</span>
                      </div>
                    )}
                    {timoPot.timo.shareUrl && (
                      <a
                        href={timoPot.timo.shareUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block break-all text-green-600 hover:text-green-700"
                      >
                        {timoPot.timo.shareUrl}
                      </a>
                    )}
                  </div>

                  <div className="space-y-0.5 text-xs text-gray-500">
                    <div>Quét gần nhất: {formatTimoTime(timoPot.timo.lastCheckedAt)}</div>
                    <div>Quét thành công gần nhất: {formatTimoTime(timoPot.timo.lastOkAt)}</div>
                    <div className="text-gray-400">Hệ thống tự quét mỗi tiếng, hoặc khi có người bấm đã chuyển tiền.</div>
                  </div>

                  {timoPot.timo.lastError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      Lỗi lần quét gần nhất: {timoPot.timo.lastError}
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleCheckTimoPot}
                    disabled={timoChecking}
                  >
                    <RefreshCw size={14} className="mr-1.5" />
                    {timoChecking ? "Đang quét..." : "Kiểm tra ngay"}
                  </Button>

                  {timoPot.timo.recentTxns.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-gray-700">Giao dịch gần đây</div>
                      {timoPot.timo.recentTxns.map((txn) => {
                        const outcome = timoOutcomeLabel(txn.outcome);
                        return (
                          <div
                            key={`${txn.seenAt}-${txn.paymentId ?? txn.description ?? ""}`}
                            className="rounded-lg border border-gray-100 bg-white px-2.5 py-2 text-xs"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-gray-500">{txn.date ?? formatTimoTime(txn.seenAt)}</span>
                              <span className="font-medium text-gray-900">
                                {typeof txn.amount === "number" ? formatCurrency(txn.amount) : "—"}
                              </span>
                            </div>
                            {txn.title && <div className="truncate text-gray-700">{txn.title}</div>}
                            {txn.description && (
                              <div className="break-words text-gray-500">{txn.description}</div>
                            )}
                            <div className={cn("mt-0.5 font-medium", outcome.className)}>{outcome.label}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {timoPot?.timo.configured && (
                <button
                  className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                  onClick={handleDeleteTimoPot}
                  disabled={timoDeleting}
                >
                  {timoDeleting ? "Đang bỏ liên kết..." : "Bỏ liên kết hũ"}
                </button>
              )}
            </div>
          )}

          {canDeleteGroup && (
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <div className="text-sm font-semibold text-red-600">Vùng nguy hiểm</div>
              <p className="text-xs text-gray-500">
                Xóa nhóm sẽ xóa toàn bộ buổi chơi, thành viên, chi phí và lời mời. Không hoàn tác được.
              </p>
              <Button variant="destructive" size="sm" onClick={handleDeleteGroup} disabled={deletingGroup}>
                <Trash2 size={15} className="mr-1.5" />
                {deletingGroup ? "Đang xóa..." : "Xóa nhóm"}
              </Button>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} title="Tạo nhóm mới">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Tên nhóm *</label>
            <Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Nhóm TingTing cuối tuần" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Mô tả</label>
            <Input
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
              placeholder="Khu vực, lịch hẹn, địa điểm quen..."
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setCreateDialogOpen(false)}>
              Hủy
            </Button>
            <Button className="flex-1" onClick={handleCreateGroup} disabled={creatingGroup || !groupName.trim()}>
              {creatingGroup ? "Đang tạo..." : "Tạo nhóm"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
