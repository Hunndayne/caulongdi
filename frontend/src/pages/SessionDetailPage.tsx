import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRightLeft,
  Camera,
  Check,
  Copy,
  Download,
  ExternalLink,
  Landmark,
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
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  BANK_DEEPLINK_OPTIONS,
  buildBankDeeplink,
  buildVietQrPayload,
  openDeeplinkWithFallback,
  type BankDeeplinkKey,
} from "@/lib/bankDeeplinks";
import { useSession } from "@/lib/auth-client";
import banksData from "@/lib/banks.json";
import { isAdminUser } from "@/lib/permissions";
import { formatCurrency, formatDate, formatSessionTimeRange, getSessionTitle } from "@/lib/utils";
import { useGroupsStore } from "@/stores/groupsStore";
import { useMembersStore } from "@/stores/membersStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import type { AiUsageStatus, Cost, Member, Payment, ReceiptParseResult, ReceiptParsedCost } from "@/types";

const TABS = ["Điểm danh", "Chi phí", "Thanh toán"] as const;
type Tab = (typeof TABS)[number];

const PAYMENT_QR_PREFIX = {
  manual: "TT",
  autoConfirm: "CLD",
} as const;
const TIMO_WEBHOOK_RECIPIENT_EMAIL = "tranthanhhung1641@gmail.com";

const COST_TYPES = [
  { value: "court", label: "Phí địa điểm" },
  { value: "water", label: "Nước" },
  { value: "shuttle", label: "Dụng cụ" },
  { value: "other", label: "Khác" },
] as const;

const COST_EXCEL_HEADERS = ["Mã", "Loại", "Mô tả", "Đơn giá", "Số lượng", "Tổng tiền", "Người ứng tiền", "Người dùng"] as const;

type CostConsumerMode = "shared" | "specific" | "pending";

type CostFormState = {
  label: string;
  amount: string;
  quantity: string;
  type: Cost["type"];
  payerId: string;
  consumerMode: CostConsumerMode;
  consumerIds: string[];
};

const defaultCostForm: CostFormState = {
  label: "",
  amount: "",
  quantity: "1",
  type: "court",
  payerId: "",
  consumerMode: "shared",
  consumerIds: [],
};

type ImportedCostRow = {
  label: string;
  amount: number;
  quantity: number;
  type: Cost["type"];
  payer_id: string | null;
  consumer_id: string | null;
  consumer_ids: string | null;
  consumer_pending: number;
  costId: string | null;
};

type ReceiptDraftItem = ReceiptParsedCost & {
  id: string;
  selected: boolean;
  payerId: string;
  consumerMode: CostConsumerMode;
  consumerIds: string[];
};

type ReceiptDraft = Omit<ReceiptParseResult, "items"> & {
  items: ReceiptDraftItem[];
};

const MAX_RECEIPT_IMAGE_WIDTH = 1200;
const MAX_RECEIPT_IMAGE_HEIGHT = 3200;
const MAX_RECEIPT_UPLOAD_BYTES = 3 * 1024 * 1024;
const RECEIPT_IMAGE_QUALITY = 0.82;

type BankDirectoryEntry = {
  bin: string;
  name: string;
  shortName?: string;
  short_name?: string;
  code?: string;
};

type PaymentQrData = {
  qrUrl: string;
  qrPayload: string;
  note: string;
  amount: number;
  recipient: Member;
  recipientBankName: string;
};

const BANK_DIRECTORY = banksData.data as BankDirectoryEntry[];

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

function parseImportQuantity(value: unknown) {
  if (String(value ?? "").trim() === "") return 1;
  const quantity = Math.round(Number(String(value ?? "").replace(/[^\d.]/g, "")));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function normalizeIdList(value: unknown) {
  let rawIds: unknown[] = [];
  if (Array.isArray(value)) {
    rawIds = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        rawIds = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        rawIds = trimmed.split(/[,;\n]+/);
      }
    }
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of rawIds) {
    const id = String(item ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function getCostConsumerIds(cost: Pick<Cost, "consumer_id" | "consumer_ids">) {
  const ids = normalizeIdList(cost.consumer_ids);
  if (ids.length > 0) return ids;
  return cost.consumer_id ? [cost.consumer_id] : [];
}

function getCostQuantity(cost: Pick<Cost, "quantity">) {
  const quantity = Math.round(Number(cost.quantity ?? 1));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function getCostUnitAmount(cost: Pick<Cost, "amount" | "quantity">) {
  return Math.round(cost.amount / getCostQuantity(cost));
}

function splitImportNames(value: unknown) {
  return String(value ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasBankInfo(member: Member | null | undefined) {
  return Boolean(member?.user_bank_bin && member?.user_bank_account_number && member?.user_bank_account_name);
}

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function isTimoWebhookRecipient(member: Member | null | undefined) {
  return normalizeEmail(member?.user_email) === TIMO_WEBHOOK_RECIPIENT_EMAIL;
}

function getBankNameByBin(bankBin?: string | null) {
  if (!bankBin) return "";
  const bank = BANK_DIRECTORY.find((item) => item.bin === bankBin);
  return bank?.name || bank?.shortName || bank?.short_name || bankBin;
}

function safeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "qr";
}

// Bỏ dấu tiếng Việt — nội dung chuyển khoản VietQR/app ngân hàng hợp nhất với ASCII.
function deburrVi(value: string) {
  return value
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// Nội dung CK dễ đọc cho luồng thủ công: "A chuyen tien buoi <sân> ngay dd/MM/yyyy".
function buildManualTransferContent(payerName: string, venue: string, date: string) {
  const [y, m, d] = date.split("-");
  const dmy = y && m && d ? `${d}/${m}/${y}` : date;
  const venuePart = venue.trim() ? `buoi ${venue.trim()} ` : "";
  const raw = `${payerName.trim()} chuyen tien ${venuePart}ngay ${dmy}`;
  return deburrVi(raw).replace(/\s+/g, " ").trim().slice(0, 80);
}

function createReceiptDraftId(index: number) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${index}`;
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Không đọc được ảnh hóa đơn."));
    };
    image.src = url;
  });
}

async function resizeReceiptImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.");
  }

  const image = await loadImage(file);
  const scale = Math.min(1, MAX_RECEIPT_IMAGE_WIDTH / image.width, MAX_RECEIPT_IMAGE_HEIGHT / image.height);
  // [debug] bật lại để soi kích thước ảnh gốc / scale:
  // console.log("[receipt] source image", {
  //   name: file.name,
  //   type: file.type,
  //   bytes: file.size,
  //   width: image.width,
  //   height: image.height,
  //   scale,
  // });

  if (scale >= 1 && file.size <= MAX_RECEIPT_UPLOAD_BYTES) {
    // console.log("[receipt] uploading without resize");
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Không xử lý được ảnh hóa đơn.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob);
      else reject(new Error("Không nén được ảnh hóa đơn."));
    }, "image/jpeg", RECEIPT_IMAGE_QUALITY);
  });

  if (blob.size > MAX_RECEIPT_UPLOAD_BYTES) {
    throw new Error("Ảnh hóa đơn vẫn quá lớn sau khi nén. Hãy chụp gần hơn hoặc cắt bớt nền.");
  }

  const name = file.name.replace(/\.[^.]+$/, "") || "receipt";
  const resized = new File([blob], `${name}.jpg`, { type: "image/jpeg" });
  // [debug] bật lại để soi kích thước ảnh sau khi nén:
  // console.log("[receipt] resized image", {
  //   bytes: resized.size,
  //   width: canvas.width,
  //   height: canvas.height,
  // });
  return resized;
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
  const [costForm, setCostForm] = useState<CostFormState>(defaultCostForm);
  const [addingCost, setAddingCost] = useState(false);
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [importingCosts, setImportingCosts] = useState(false);
  const [scanningReceipt, setScanningReceipt] = useState(false);
  const [savingReceiptDraft, setSavingReceiptDraft] = useState(false);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null);
  const [receiptDiscount, setReceiptDiscount] = useState("");
  const [receiptAiUsage, setReceiptAiUsage] = useState<AiUsageStatus | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [managingSettings, setManagingSettings] = useState(false);
  const [showManagerSettings, setShowManagerSettings] = useState(false);
  const [recipientId, setRecipientId] = useState("");
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [bankDialogPayment, setBankDialogPayment] = useState<PaymentQrData | null>(null);
  const [bankOpenNotice, setBankOpenNotice] = useState("");
  const costImportInputRef = useRef<HTMLInputElement | null>(null);
  const receiptInputRef = useRef<HTMLInputElement | null>(null);

  const currentUserId = (authSession?.user as { id?: string } | undefined)?.id;
  const managersList = useMemo(() => parseManagers(currentSession?.managers), [currentSession?.managers]);
  const groupRole = currentSession?.group_id
    ? groups.find((group) => group.id === currentSession.group_id)?.role
    : undefined;

  const canManageSession = Boolean(
    isAdminUser(authSession?.user) ||
    (currentUserId && currentSession?.created_by === currentUserId) ||
    (currentUserId && managersList.includes(currentUserId)) ||
    currentSession?.allow_all_edit ||
    groupRole === "admin"
  );

  const canManageSessionStrict = Boolean(
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
    const raw = currentSession?.payment_recipient ?? "";
    if (raw.startsWith("auto_")) {
      setAutoConfirm(true);
      setRecipientId(raw.slice(5));
    } else {
      setAutoConfirm(false);
      setRecipientId(raw);
    }
  }, [currentSession?.id, currentSession?.payment_recipient]);

  useEffect(() => {
    if (!currentSession?.id || !canManageSession || tab !== "Chi phí") {
      setReceiptAiUsage(null);
      return;
    }

    let cancelled = false;
    api.getReceiptAiUsage(currentSession.id)
      .then((usage) => {
        if (!cancelled) setReceiptAiUsage(usage);
      })
      .catch(() => {
        if (!cancelled) setReceiptAiUsage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [currentSession?.id, canManageSession, tab]);

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
  const hasCalculatedPayments = s.payments.length > 0;
  const canOverrideAttendanceLock = isAdminUser(authSession?.user) || groupRole === "admin";
  const attendanceLeaveLocked = hasCalculatedPayments && !canOverrideAttendanceLock;

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
  const fallbackRecipientUsesTimoWebhook = isTimoWebhookRecipient(fallbackRecipientMember);
  const effectiveAutoConfirm = fallbackRecipientUsesTimoWebhook || autoConfirm;
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
    const nextRecipient = value ? memberById.get(value) ?? null : null;
    const nextAutoConfirm = isTimoWebhookRecipient(nextRecipient) || (autoConfirm && !fallbackRecipientUsesTimoWebhook);
    setRecipientId(value);
    setAutoConfirm(nextAutoConfirm);
    if (!canManageSession || !id) return;
    const stored = value ? (nextAutoConfirm ? `auto_${value}` : value) : null;
    try {
      await api.updateSession(id, { payment_recipient: stored } as any);
    } catch {
      // keep local selection optimistic; refresh will reconcile if needed
    }
  };

  const handleToggleAutoConfirm = async () => {
    if (fallbackRecipientUsesTimoWebhook) {
      setAutoConfirm(true);
      return;
    }
    const next = !autoConfirm;
    setAutoConfirm(next);
    if (!canManageSession || !id || !recipientId) return;
    const stored = next ? `auto_${recipientId}` : recipientId;
    try {
      await api.updateSession(id, { payment_recipient: stored } as any);
    } catch {
      setAutoConfirm(!next);
    }
  };

  const toggleMember = async (memberId: string) => {
    if (!canManageSession) return;
    const isLeaving = checkedInIds.has(memberId);
    if (isLeaving && attendanceLeaveLocked) {
      alert("Đã tính tiền, chỉ admin mới được bỏ điểm danh buổi này.");
      return;
    }

    try {
      if (isLeaving) {
        await api.removeSessionMember(s.id, memberId);
      } else {
        await api.addSessionMember(s.id, memberId);
      }
      await refresh(s.id);
    } catch (error: any) {
      alert(error.message);
    }
  };

  const handleJoinToggle = async () => {
    if (s.status !== "upcoming") return;
    if (hasJoined && attendanceLeaveLocked) {
      alert("Đã tính tiền, chỉ admin mới được bỏ điểm danh buổi này.");
      return;
    }

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
          title: `${getSessionTitle(s)} - ${formatDate(s.date)}`,
          text: `Buổi chơi ${getSessionTitle(s)}`,
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

  const resolveImportedMembers = (value: unknown, rowNumber: number, columnName: string) => {
    const names = splitImportNames(value);
    const seen = new Set<string>();
    const selected: Member[] = [];
    for (const name of names) {
      const member = resolveImportedMember(name, rowNumber, columnName);
      if (!member || seen.has(member.id)) continue;
      seen.add(member.id);
      selected.push(member);
    }
    return selected;
  };

  const handleExportCosts = async () => {
    const XLSX = await import("xlsx");
    const costRows = s.costs.map((cost) => {
      const payer = cost.payer_id ? memberById.get(cost.payer_id) : null;
      const consumerNames = cost.consumer_pending
        ? "Chưa rõ"
        : getCostConsumerIds(cost).map((memberId) => memberById.get(memberId)?.name ?? memberId).join(", ");
      const quantity = getCostQuantity(cost);
      const unitAmount = getCostUnitAmount(cost);
      return [
        cost.id,
        getCostTypeLabel(cost.type),
        cost.label,
        unitAmount,
        quantity,
        cost.amount,
        payer?.name ?? "",
        consumerNames,
      ];
    });

    const workbook = XLSX.utils.book_new();
    const costSheet = XLSX.utils.aoa_to_sheet([[...COST_EXCEL_HEADERS], ...costRows]);
    costSheet["!cols"] = [
      { wch: 24 },
      { wch: 14 },
      { wch: 28 },
      { wch: 14 },
      { wch: 10 },
      { wch: 14 },
      { wch: 24 },
      { wch: 32 },
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
        .map((row, index): ImportedCostRow | null => {
          const rowNumber = index + 2;
          const costIdRaw = readImportCell(row, ["Mã", "Ma", "ID", "Cost ID"]);
          const typeRaw = readImportCell(row, ["Loại", "Loai", "Type"]);
          const labelRaw = readImportCell(row, ["Mô tả", "Mo ta", "Mô tả khoản chi", "Label"]);
          const unitAmountRaw = readImportCell(row, ["Đơn giá", "Don gia", "Số tiền", "So tien", "Amount", "Unit price"]);
          const quantityRaw = readImportCell(row, ["Số lượng", "So luong", "Quantity", "Qty"]);
          const totalAmountRaw = readImportCell(row, ["Tổng tiền", "Tong tien", "Total", "Total amount"]);
          const payerRaw = readImportCell(row, ["Người ứng tiền", "Nguoi ung tien", "Người trả", "Payer"]);
          const consumerRaw = readImportCell(row, ["Người dùng", "Nguoi dung", "Người dùng riêng", "Nguoi dung rieng", "Consumer", "Consumers"]);

          const isEmpty = [costIdRaw, typeRaw, labelRaw, unitAmountRaw, quantityRaw, totalAmountRaw, payerRaw, consumerRaw]
            .every((value) => String(value ?? "").trim() === "");
          if (isEmpty) return null;

          const costId = String(costIdRaw ?? "").trim();
          const quantity = parseImportQuantity(quantityRaw);
          if (!quantity) throw new Error(`Dòng ${rowNumber}: số lượng không hợp lệ.`);
          const unitAmount = parseImportAmount(unitAmountRaw);
          const totalAmount = parseImportAmount(totalAmountRaw);
          const amount = unitAmount ? unitAmount * quantity : totalAmount;
          if (!amount) throw new Error(`Dòng ${rowNumber}: số tiền không hợp lệ.`);

          const typeKey = normalizeImportText(typeRaw);
          const type = (COST_TYPES.find((item) =>
            normalizeImportText(item.label) === typeKey || normalizeImportText(item.value) === typeKey
          )?.value ?? "other") as Cost["type"];
          const label = String(labelRaw || getCostTypeLabel(type)).trim();
          const payer = resolveImportedMember(payerRaw, rowNumber, "Người ứng tiền");
          const consumerRawNormalized = normalizeImportText(consumerRaw);
          const isPending = consumerRawNormalized === "chua ro" || consumerRawNormalized === "chưa rõ";
          const isShared = !consumerRawNormalized
            || consumerRawNormalized === "dung chung"
            || consumerRawNormalized === "ca nhom"
            || consumerRawNormalized === "tat ca";
          const consumerIds = isPending || isShared
            ? []
            : resolveImportedMembers(consumerRaw, rowNumber, "Người dùng").map((member) => member.id);

          return {
            label,
            amount,
            quantity,
            type,
            payer_id: payer?.id ?? null,
            consumer_id: consumerIds[0] ?? null,
            consumer_ids: consumerIds.length > 0 ? JSON.stringify(consumerIds) : null,
            consumer_pending: isPending ? 1 : 0,
            costId: costId || null,
          };
        })
        .filter((item): item is ImportedCostRow => Boolean(item));

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

  const handleScanReceipt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (receiptAiUsage && !receiptAiUsage.enabled) {
      alert("Tính năng quét hóa đơn AI đang tạm tắt vì gần hết hạn mức neuron miễn phí hôm nay.");
      return;
    }

    setScanningReceipt(true);
    try {
      const preparedImage = await resizeReceiptImage(file);
      const formData = new FormData();
      formData.append("file", preparedImage);

      const parsed = await api.parseReceipt(s.id, formData);
      if (parsed.aiUsage) setReceiptAiUsage(parsed.aiUsage);
      if (parsed.items.length === 0) throw new Error("Không tìm thấy dòng chi phí nào trong hóa đơn.");

      setReceiptDiscount("");
      setReceiptDraft({
        ...parsed,
        items: parsed.items.map((item, index) => {
          const quantity = Math.max(1, Math.round(Number(item.quantity || 1)));
          const unitAmount = Math.max(0, Math.round(Number(item.unitAmount || item.totalAmount / quantity || 0)));
          const totalAmount = Math.max(0, Math.round(Number(item.totalAmount || unitAmount * quantity)));
          return {
            ...item,
            id: createReceiptDraftId(index),
            selected: totalAmount > 0,
            payerId: "",
            consumerMode: "shared",
            consumerIds: [],
            quantity,
            unitAmount,
            totalAmount,
          };
        }),
      });
    } catch (error: any) {
      alert(error.message);
    } finally {
      setScanningReceipt(false);
    }
  };

  const updateReceiptDraftItem = (itemId: string, patch: Partial<ReceiptDraftItem>) => {
    setReceiptDraft((current) => current
      ? {
        ...current,
        items: current.items.map((item) => item.id === itemId ? { ...item, ...patch } : item),
      }
      : current);
  };

  const updateReceiptDraftAmount = (itemId: string, field: "unitAmount" | "quantity", raw: string) => {
    setReceiptDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) => {
          if (item.id !== itemId) return item;
          const next = { ...item };
          if (field === "quantity") {
            next.quantity = parseImportQuantity(raw) ?? 1;
          } else {
            next.unitAmount = parseImportAmount(raw) ?? 0;
          }
          next.totalAmount = Math.round(next.unitAmount * next.quantity);
          return next;
        }),
      };
    });
  };

  const setReceiptDraftConsumerMode = (itemId: string, consumerMode: CostConsumerMode) => {
    setReceiptDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) => item.id === itemId
          ? {
            ...item,
            consumerMode,
            consumerIds: consumerMode === "specific" ? item.consumerIds : [],
          }
          : item),
      };
    });
  };

  const toggleReceiptDraftConsumer = (itemId: string, memberId: string) => {
    setReceiptDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) => {
          if (item.id !== itemId) return item;
          const selected = item.consumerIds.includes(memberId);
          return {
            ...item,
            consumerIds: selected
              ? item.consumerIds.filter((idValue) => idValue !== memberId)
              : [...item.consumerIds, memberId],
          };
        }),
      };
    });
  };

  const handleAddReceiptDraftCosts = async () => {
    if (!receiptDraft) return;
    const selectedItems = receiptDraft.items.filter((item) => item.selected);
    if (selectedItems.length === 0) {
      alert("Chọn ít nhất một dòng hóa đơn để thêm.");
      return;
    }
    const missingConsumers = selectedItems.find((item) => item.consumerMode === "specific" && item.consumerIds.length === 0);
    if (missingConsumers) {
      alert(`Chọn người dùng cho "${missingConsumers.label}".`);
      return;
    }

    // Phân bổ giảm giá theo tỉ lệ thành tiền từng món (làm tròn, dồn phần dư vào dòng cuối).
    const selectedTotal = selectedItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const discount = Math.min(Math.max(0, parseImportAmount(receiptDiscount) ?? 0), selectedTotal);
    const lineAmounts = new Map<string, number>();
    if (discount > 0 && selectedTotal > 0) {
      let allocated = 0;
      selectedItems.forEach((item, index) => {
        const itemDiscount = index === selectedItems.length - 1
          ? discount - allocated
          : Math.round((discount * item.totalAmount) / selectedTotal);
        allocated += itemDiscount;
        lineAmounts.set(item.id, Math.max(0, item.totalAmount - itemDiscount));
      });
    } else {
      selectedItems.forEach((item) => lineAmounts.set(item.id, item.totalAmount));
    }

    const payableItems = selectedItems.filter((item) => (lineAmounts.get(item.id) ?? 0) > 0);
    if (payableItems.length === 0) {
      alert("Số tiền giảm giá lớn hơn hoặc bằng tổng các món được chọn.");
      return;
    }

    setSavingReceiptDraft(true);
    try {
      for (const item of payableItems) {
        const consumerIds = item.consumerMode === "specific" ? item.consumerIds : [];
        await api.addCost(s.id, {
          label: item.label.trim(),
          amount: lineAmounts.get(item.id) ?? Math.round(item.totalAmount || item.unitAmount * item.quantity),
          quantity: item.quantity,
          type: item.type,
          payer_id: item.payerId || null,
          consumer_id: consumerIds[0] ?? null,
          consumer_ids: consumerIds.length > 0 ? JSON.stringify(consumerIds) : null,
          consumer_pending: item.consumerMode === "pending" ? 1 : 0,
        });
      }

      setReceiptDraft(null);
      await refresh(s.id);
      const discountNote = discount > 0 ? ` (đã trừ ${formatCurrency(discount)} giảm giá)` : "";
      alert(`Đã thêm ${payableItems.length} dòng từ hóa đơn${discountNote}.`);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setSavingReceiptDraft(false);
    }
  };

  const resetCostForm = () => {
    setCostForm(defaultCostForm);
    setEditingCostId(null);
  };

  const handleStartEditCost = (cost: Cost) => {
    const consumerIds = cost.consumer_pending ? [] : getCostConsumerIds(cost);
    setEditingCostId(cost.id);
    setCostForm({
      label: cost.label,
      amount: String(getCostUnitAmount(cost)),
      quantity: String(getCostQuantity(cost)),
      type: cost.type,
      payerId: cost.payer_id ?? "",
      consumerMode: cost.consumer_pending ? "pending" : (consumerIds.length > 0 ? "specific" : "shared"),
      consumerIds,
    });
  };

  const handleSaveCost = async () => {
    if (!costForm.label.trim() || !costForm.amount) return;
    const unitAmount = parseFloat(costForm.amount);
    const quantity = Math.round(Number(costForm.quantity || "1"));
    if (!Number.isFinite(unitAmount) || unitAmount <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
    if (costForm.consumerMode === "specific" && costForm.consumerIds.length === 0) {
      alert("Chọn ít nhất một người dùng cho món này.");
      return;
    }

    setAddingCost(true);
    try {
      const consumerIds = costForm.consumerMode === "specific" ? costForm.consumerIds : [];
      const payload = {
        label: costForm.label.trim(),
        amount: Math.round(unitAmount * quantity),
        quantity,
        type: costForm.type as Cost["type"],
        payer_id: costForm.payerId || null,
        consumer_id: consumerIds[0] ?? null,
        consumer_ids: consumerIds.length > 0 ? JSON.stringify(consumerIds) : null,
        consumer_pending: costForm.consumerMode === "pending" ? 1 : 0,
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

  const updateCostAmountInput = (raw: string) => {
    const parsed = parseInt(raw, 10);
    setCostForm((current) => ({
      ...current,
      amount: Number.isFinite(parsed) && parsed > 0 ? String(parsed) : raw.replace(/[^\d]/g, ""),
    }));
  };

  const updateCostQuantityInput = (raw: string) => {
    const parsed = parseInt(raw, 10);
    setCostForm((current) => ({
      ...current,
      quantity: Number.isFinite(parsed) && parsed > 0 ? String(parsed) : raw.replace(/[^\d]/g, ""),
    }));
  };

  const setCostConsumerMode = (consumerMode: CostConsumerMode) => {
    setCostForm((current) => ({
      ...current,
      consumerMode,
      consumerIds: consumerMode === "specific" ? current.consumerIds : [],
    }));
  };

  const toggleCostConsumer = (memberId: string) => {
    setCostForm((current) => {
      const selected = current.consumerIds.includes(memberId);
      return {
        ...current,
        consumerIds: selected
          ? current.consumerIds.filter((idValue) => idValue !== memberId)
          : [...current.consumerIds, memberId],
      };
    });
  };

  const renderCostConsumerControls = () => (
    <div>
      <label className="mb-1 block text-xs text-gray-500">Người dùng</label>
      <select
        value={costForm.consumerMode}
        onChange={(event) => setCostConsumerMode(event.target.value as CostConsumerMode)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        <option value="shared">Dùng chung</option>
        <option value="specific">Chọn người dùng</option>
        <option value="pending">Chưa rõ</option>
      </select>

      {costForm.consumerMode === "specific" && (
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {s.members.map((member) => {
            const checked = costForm.consumerIds.includes(member.id);
            return (
              <label
                key={member.id}
                className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                  checked ? "border-green-300 bg-green-50 text-green-900" : "border-gray-200 bg-white text-gray-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleCostConsumer(member.id)}
                  className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-green-600 focus:ring-green-500"
                />
                <span className="truncate">{member.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

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
  const totalTransferAmount = paymentRows.reduce((sum, row) => sum + row.payment.amount_owed, 0);
  const confirmedTransferAmount = paymentRows.reduce(
    (sum, row) => sum + (row.payment.paid ? row.payment.amount_owed : 0),
    0
  );
  const paymentProgressTarget = totalCost > 0 ? totalCost : totalTransferAmount;
  const confirmedCostProgress = Math.min(confirmedTransferAmount, paymentProgressTarget);

  const buildQrData = (paymentId: string, debtor: Member, recipient: Member, amount: number): PaymentQrData | null => {
    if (!recipient.user_bank_bin || !recipient.user_bank_account_number || !recipient.user_bank_account_name) return null;
    if (amount <= 0 || debtor.id === recipient.id) return null;
    const isAutoRecipient = isTimoWebhookRecipient(recipient) || (effectiveAutoConfirm && recipient.id === recipientId);
    // Tự động (CLD): GIỮ mã để webhook Timo đối soát. Thủ công (TT cũ): mã vô dụng
    // (email không về hộp webhook) → thay bằng nội dung dễ đọc cho người nhận.
    const note = isAutoRecipient
      ? `${PAYMENT_QR_PREFIX.autoConfirm}-${paymentId}`
      : buildManualTransferContent(debtor.name, s.venue, s.date);
    const roundedAmount = Math.ceil(amount);
    const qrUrl = `https://img.vietqr.io/image/${recipient.user_bank_bin}-${recipient.user_bank_account_number}-compact.png?amount=${roundedAmount}&addInfo=${encodeURIComponent(note)}&accountName=${encodeURIComponent(recipient.user_bank_account_name)}`;

    try {
      return {
        qrUrl,
        qrPayload: buildVietQrPayload({
          bankBin: recipient.user_bank_bin,
          accountNumber: recipient.user_bank_account_number,
          amount: roundedAmount,
          description: note,
        }),
        note,
        amount: roundedAmount,
        recipient,
        recipientBankName: getBankNameByBin(recipient.user_bank_bin),
      };
    } catch {
      return null;
    }
  };

  const handleOpenBankDialog = (qrData: PaymentQrData) => {
    setBankOpenNotice("");
    setBankDialogPayment(qrData);
  };

  const handleOpenBank = (bankKey: BankDeeplinkKey) => {
    if (!bankDialogPayment) return;

    try {
      const result = buildBankDeeplink({
        bankKey,
        qrPayload: bankDialogPayment.qrPayload,
        timoPayload: {
          bankCode: bankDialogPayment.recipient.user_bank_bin ?? "",
          bankName: bankDialogPayment.recipientBankName,
          accNumber: bankDialogPayment.recipient.user_bank_account_number ?? "",
          amount: bankDialogPayment.amount,
          description: bankDialogPayment.note,
          editable: false,
        },
      });

      setBankOpenNotice("");
      openDeeplinkWithFallback({
        deeplinkUrl: result.url,
        onFallback: () => {
          setBankOpenNotice("Nếu app ngân hàng không mở, bạn vẫn có thể quét hoặc tải mã QR bên dưới.");
        },
      });
    } catch (error: any) {
      setBankOpenNotice(error.message || "Không tạo được deeplink cho ngân hàng này.");
    }
  };

  const handleDownloadQr = async (qrData: PaymentQrData) => {
    const fileName = `tingting-${safeFileName(qrData.note)}.png`;

    try {
      const response = await fetch(qrData.qrUrl);
      if (!response.ok) throw new Error("QR image fetch failed");

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      const link = document.createElement("a");
      link.href = qrData.qrUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  };

  const canTogglePaymentRow = (payment: Payment, debtor: Member | null, recipient: Member | null) => {
    if (payment.paid) return false;
    if (!currentUserId) return false;
    if (debtor?.user_id === currentUserId) return payment.payer_marked_paid !== 1;
    if (recipient?.user_id === currentUserId) return true;
    return false;
  };

  const getPaymentActionLabel = (payment: Payment, debtor: Member | null, recipient: Member | null) => {
    const isRecipientUser = Boolean(currentUserId && recipient?.user_id === currentUserId && debtor?.user_id !== currentUserId);
    const isDebtorUser = Boolean(currentUserId && debtor?.user_id === currentUserId);
    if (payment.paid) return isRecipientUser ? "Đã nhận ✓" : "Đã xong ✓";
    if (isRecipientUser) return payment.payer_marked_paid ? "Xác nhận đã nhận" : "Đánh dấu đã nhận";
    if (isDebtorUser) return payment.payer_marked_paid ? "Chờ xác nhận" : "Đánh dấu đã trả";
    return payment.payer_marked_paid ? "Chờ xác nhận" : "Chưa trả";
  };

  const copyNotification = async () => {
    const costBreakdown = s.costs.length > 0
      ? s.costs.map((cost) => {
        const quantity = getCostQuantity(cost);
        if (quantity <= 1) return `${cost.label}: ${formatCurrency(cost.amount)}`;
        return `${cost.label}: ${quantity} x ${formatCurrency(getCostUnitAmount(cost))} = ${formatCurrency(cost.amount)}`;
      }).join(" | ")
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
      `Buổi chơi: ${getSessionTitle(s)}`,
      `Thời gian: ${formatDate(s.date)} · ${formatSessionTimeRange(s)}`,
      `Sân: ${s.venue}`,
      `Địa chỉ: ${s.location ?? "-"}`,
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
  const receiptDraftSelectedItems = receiptDraft?.items.filter((item) => item.selected) ?? [];
  const receiptDraftSelectedTotal = receiptDraftSelectedItems.reduce((sum, item) => sum + item.totalAmount, 0);
  const receiptDiscountValue = Math.min(Math.max(0, parseImportAmount(receiptDiscount) ?? 0), receiptDraftSelectedTotal);
  const receiptDraftAfterDiscount = receiptDraftSelectedTotal - receiptDiscountValue;
  const receiptAiDisabled = receiptAiUsage?.enabled === false;
  const receiptAiUsageText = receiptAiUsage
    ? `${receiptAiUsage.estimatedNeurons.toLocaleString("vi-VN")}/${receiptAiUsage.dailyBudget.toLocaleString("vi-VN")} neurons hôm nay`
    : "";

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/sessions" className="rounded-lg p-2 hover:bg-gray-100">
          <ArrowLeft size={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-gray-900">{getSessionTitle(s)}</h1>
          <div className="text-sm text-gray-500">
            {formatDate(s.date)} · {formatSessionTimeRange(s)}
          </div>
          <div className="truncate text-sm text-gray-500">
            {[s.venue, s.location].filter(Boolean).join(" - ")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={s.status === "upcoming" ? "green" : "gray"}>
            {s.status === "upcoming" ? "Sắp tới" : "Hoàn thành"}
          </Badge>
          {canManageSessionStrict && (
            <Button variant="ghost" size="icon" onClick={handleDeleteSession} className="text-red-500">
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </div>

      {canManageSessionStrict && s.status === "upcoming" && (
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
          disabled={joining || s.status !== "upcoming" || (hasJoined && attendanceLeaveLocked)}
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

      {attendanceLeaveLocked && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Đã tính tiền, chỉ admin mới được bỏ điểm danh khỏi buổi này.
        </div>
      )}

      {canManageSessionStrict && (
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

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(currentSession?.allow_all_edit)}
                  onChange={async () => {
                    const nextValue = currentSession?.allow_all_edit ? 0 : 1;
                    setManagingSettings(true);
                    try {
                      await api.updateSession(s.id, { allow_all_edit: nextValue } as any);
                      await refresh(s.id);
                    } catch (error: any) {
                      alert(error.message);
                    } finally {
                      setManagingSettings(false);
                    }
                  }}
                  className="rounded border-gray-300"
                />
                <span className="text-gray-700">Cho phép tất cả thành viên chỉnh sửa</span>
              </label>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-gray-700">Người nhận chung</label>
                <select
                  value={recipientId}
                  onChange={(event) => handleSetRecipient(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">-- Chưa chọn --</option>
                  {membersWithBank.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
                {recipientId && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(currentSession?.force_payment_recipient)}
                        disabled={!recipientId}
                        onChange={async () => {
                          const nextValue = currentSession?.force_payment_recipient ? 0 : 1;
                          setManagingSettings(true);
                          try {
                            await api.updateSession(s.id, { force_payment_recipient: nextValue } as any);
                            await refresh(s.id);
                          } catch (error: any) {
                            alert(error.message);
                          } finally {
                            setManagingSettings(false);
                          }
                        }}
                        className="rounded border-gray-300"
                      />
                      <span className="text-gray-700">Tất cả tiền chuyển về người nhận chung</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={effectiveAutoConfirm}
                        disabled={fallbackRecipientUsesTimoWebhook}
                        onChange={handleToggleAutoConfirm}
                        className="rounded border-gray-300"
                      />
                      <span className="text-gray-700">Webhook tự động xác nhận (Timo)</span>
                    </label>
                  </div>
                )}
                {recipientId && s.payments.length > 0 && (
                  <div className="text-xs text-gray-500">
                    Tổng nhận:{" "}
                    <span className="font-semibold text-gray-700">
                      {formatCurrency(
                        paymentRows
                          .filter(({ payment }) => payment.recipient_member_id === recipientId)
                          .reduce((sum, { payment }) => sum + payment.amount_owed, 0)
                      )}
                    </span>
                  </div>
                )}
                {membersWithBank.length === 0 && (
                  <div className="text-xs text-gray-400">Chưa có thành viên nào cập nhật STK.</div>
                )}
              </div>

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
            <span className="text-sm text-gray-500">{checkedInIds.size} người tham gia</span>
          </div>
          <div className="space-y-2">
            {(s.group_id && members.filter((member) => member.is_active).length > 0 ? members.filter((member) => member.is_active) : s.members).map((member) => {
              const checked = checkedInIds.has(member.id);
              const leaveLocked = checked && attendanceLeaveLocked;
              return (
                <button
                  key={member.id}
                  onClick={() => toggleMember(member.id)}
                  disabled={!canManageSession || leaveLocked}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "border-green-200 bg-green-50" : "border-gray-100 bg-white"}`}
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
          <div className={`grid grid-cols-1 gap-2 ${canManageSession ? "sm:grid-cols-3" : ""}`}>
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
                <input
                  ref={receiptInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleScanReceipt}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => receiptInputRef.current?.click()}
                  disabled={scanningReceipt || receiptAiDisabled}
                  className="flex-1"
                >
                  <Camera size={14} className="mr-1" />
                  {receiptAiDisabled ? "Tạm tắt AI" : scanningReceipt ? "Đang quét..." : "Quét hóa đơn"}
                </Button>
              </>
            )}
          </div>
          {canManageSession && receiptAiUsage && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${
              receiptAiDisabled
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-gray-200 bg-gray-50 text-gray-500"
            }`}
            >
              AI hóa đơn: {receiptAiUsageText}. {receiptAiDisabled
                ? "Đã gần hết hạn mức miễn phí, tự mở lại sau 00:00 UTC."
                : `Còn khoảng ${receiptAiUsage.remainingNeurons.toLocaleString("vi-VN")} neurons.`}
            </div>
          )}

          {canManageSession && !editingCostId && (
            <div className="space-y-3 rounded-xl bg-gray-50 p-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <select
                  value={costForm.type}
                  onChange={(event) =>
                    setCostForm((current) => ({
                      ...current,
                      type: event.target.value as Cost["type"],
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
                  onChange={(event) => updateCostAmountInput(event.target.value)}
                  placeholder="Đơn giá (VNĐ)"
                  type="number"
                  min="0"
                  step="1"
                />
                <Input
                  value={costForm.quantity}
                  onChange={(event) => updateCostQuantityInput(event.target.value)}
                  placeholder="Số lượng"
                  type="number"
                  min="1"
                  step="1"
                />
              </div>

              <Input
                value={costForm.label}
                onChange={(event) => setCostForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="Mô tả"
              />

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                {renderCostConsumerControls()}
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={handleSaveCost} disabled={addingCost || !costForm.label || !costForm.amount || !costForm.quantity}>
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
                const consumerIds = cost.consumer_pending ? [] : getCostConsumerIds(cost);
                const consumerNames = consumerIds.map((memberId) => memberById.get(memberId)?.name ?? memberId);
                const consumerLabel = consumerNames.join(", ");
                const quantity = getCostQuantity(cost);
                const unitAmount = getCostUnitAmount(cost);

                let helperText = "Trả cho người nhận chung";
                let helperClass = "text-green-500";
                if (cost.consumer_pending) {
                  helperText = "Chưa rõ ai dùng — chưa tính vào chia tiền";
                  helperClass = "text-amber-500";
                } else if (payerMember && consumerIds.length > 0) {
                  helperText = `${consumerLabel} trả lại cho ${payerMember.name}`;
                  helperClass = "text-orange-500";
                } else if (consumerIds.length > 0) {
                  helperText = `${consumerLabel} trả lại cho người nhận chung`;
                  helperClass = "text-orange-500";
                } else if (payerMember) {
                  helperText = `Cả nhóm trả lại cho ${payerMember.name}`;
                  helperClass = "text-blue-500";
                }

                if (cost.id === editingCostId) {
                  return (
                    <div key={cost.id} className="space-y-3 rounded-xl border-2 border-green-300 bg-green-50 p-4">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <select
                          value={costForm.type}
                          onChange={(event) =>
                            setCostForm((current) => ({
                              ...current,
                              type: event.target.value as Cost["type"],
                              label: COST_TYPES.find((item) => item.value === event.target.value)?.label ?? current.label,
                            }))
                          }
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                        >
                          {COST_TYPES.map((item) => (
                            <option key={item.value} value={item.value}>{item.label}</option>
                          ))}
                        </select>
                        <Input
                          value={costForm.amount}
                          onChange={(event) => updateCostAmountInput(event.target.value)}
                          placeholder="Đơn giá (VNĐ)"
                          type="number"
                          min="0"
                          step="1"
                        />
                        <Input
                          value={costForm.quantity}
                          onChange={(event) => updateCostQuantityInput(event.target.value)}
                          placeholder="Số lượng"
                          type="number"
                          min="1"
                          step="1"
                        />
                      </div>
                      <Input
                        value={costForm.label}
                        onChange={(event) => setCostForm((current) => ({ ...current, label: event.target.value }))}
                        placeholder="Mô tả"
                      />
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">Người ứng tiền</label>
                          <select
                            value={costForm.payerId}
                            onChange={(event) => setCostForm((current) => ({ ...current, payerId: event.target.value }))}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          >
                            <option value="">Người nhận chung</option>
                            {s.members.map((member) => (
                              <option key={member.id} value={member.id}>{member.name}</option>
                            ))}
                          </select>
                        </div>
                        {renderCostConsumerControls()}
                      </div>
                      <div className="flex gap-2">
                        <Button className="flex-1" onClick={handleSaveCost} disabled={addingCost || !costForm.label || !costForm.amount || !costForm.quantity}>
                          {addingCost ? "Đang lưu..." : "Lưu"}
                        </Button>
                        <Button variant="outline" size="icon" onClick={resetCostForm} disabled={addingCost}>
                          <X size={16} />
                        </Button>
                      </div>
                    </div>
                  );
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
                      <div className="text-right">
                        <div className="font-semibold text-gray-900">{formatCurrency(cost.amount)}</div>
                        {quantity > 1 && (
                          <div className="text-xs text-gray-400">
                            {quantity} x {formatCurrency(unitAmount)}
                          </div>
                        )}
                      </div>
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
                const qrData = canViewQr && debtor && qrRecipient ? buildQrData(payment.id, debtor, qrRecipient, payment.amount_owed) : null;
                const fallbackNotice = !recipientHasBank && qrRecipient && recipient
                  ? `Người ứng tiền chưa cập nhật STK, tạm chuyển qua ${qrRecipient.name}.`
                  : null;
                const pendingNotice = payment.payer_marked_paid && !payment.paid
                  ? `${debtorName} đã báo đã trả, chờ ${recipientName} xác nhận đã nhận.`
                  : null;
                const toggleAllowed = canTogglePaymentRow(payment, debtor, recipient);
                const showMissingQrNotice = canViewQr && !qrData && !payment.paid;

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

                    {qrData && !payment.paid && (
                      <div className="mt-3 flex flex-col items-center gap-2">
                        <img
                          src={qrData.qrUrl}
                          alt={`QR chuyển khoản cho ${qrRecipient?.name ?? recipientName}`}
                          className="h-auto w-48 rounded-lg border border-gray-200"
                          loading="lazy"
                        />
                        <div className="text-center text-xs text-gray-500">
                          QR nhận tiền: {qrRecipient?.name ?? recipientName}
                        </div>
                        <div className="grid w-full max-w-xs grid-cols-2 gap-2">
                          <Button size="sm" onClick={() => handleOpenBankDialog(qrData)}>
                            <ExternalLink size={14} className="mr-1" />
                            Mở ngân hàng
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => handleDownloadQr(qrData)}>
                            <Download size={14} className="mr-1" />
                            Tải mã QR
                          </Button>
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
                  <span className="text-sm text-gray-600">Đã thanh toán</span>
                  <span className="text-sm font-medium text-gray-900">
                    {formatCurrency(confirmedCostProgress)}/{formatCurrency(paymentProgressTarget)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Tổng cần chuyển</span>
                  <span className="text-sm font-medium text-gray-900">
                    {formatCurrency(totalTransferAmount)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {scanningReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-4 rounded-2xl bg-white px-6 py-5 shadow-xl">
            <img
              src="https://storage.hiseku.net/loading.webp"
              alt="Đang xử lý"
              width={360}
              height={360}
              className="h-40 w-40 sm:h-56 sm:w-56"
            />
            <div className="text-center">
              <div className="text-base font-semibold text-gray-900">Đang quét hóa đơn…</div>
              <div className="mt-1 text-xs text-gray-500">AI đang đọc và bóc tách các dòng chi phí. Quá trình này có thể mất 10–30 giây.</div>
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(receiptDraft)}
        onClose={() => {
          if (!savingReceiptDraft) setReceiptDraft(null);
        }}
        title="Duyệt hóa đơn"
        className="sm:max-w-2xl"
      >
        {receiptDraft && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 rounded-lg bg-gray-50 p-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-gray-500">Cửa hàng</div>
                <div className="font-medium text-gray-900">{receiptDraft.merchantName || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Ngày hóa đơn</div>
                <div className="font-medium text-gray-900">{receiptDraft.purchasedAt || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Tổng nhận diện</div>
                <div className="font-semibold text-gray-900">{formatCurrency(receiptDraft.totalAmount ?? 0)}</div>
              </div>
            </div>

            <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {receiptDraft.items.map((item, index) => (
                <div
                  key={item.id}
                  className={`rounded-lg border p-3 ${item.selected ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50 opacity-75"}`}
                >
                  <div className="mb-3 flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(event) => updateReceiptDraftItem(item.id, { selected: event.target.checked })}
                      disabled={savingReceiptDraft}
                      className="mt-2 h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    <div className="min-w-0 flex-1">
                      <Input
                        value={item.label}
                        onChange={(event) => updateReceiptDraftItem(item.id, { label: event.target.value })}
                        disabled={!item.selected || savingReceiptDraft}
                        placeholder={`Dòng ${index + 1}`}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <select
                      value={item.type}
                      onChange={(event) => updateReceiptDraftItem(item.id, { type: event.target.value as Cost["type"] })}
                      disabled={!item.selected || savingReceiptDraft}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                    >
                      {COST_TYPES.map((costType) => (
                        <option key={costType.value} value={costType.value}>{costType.label}</option>
                      ))}
                    </select>
                    <Input
                      value={item.unitAmount || ""}
                      onChange={(event) => updateReceiptDraftAmount(item.id, "unitAmount", event.target.value)}
                      disabled={!item.selected || savingReceiptDraft}
                      placeholder="Đơn giá"
                      type="number"
                      min="0"
                      step="1"
                    />
                    <Input
                      value={item.quantity || ""}
                      onChange={(event) => updateReceiptDraftAmount(item.id, "quantity", event.target.value)}
                      disabled={!item.selected || savingReceiptDraft}
                      placeholder="Số lượng"
                      type="number"
                      min="1"
                      step="1"
                    />
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Người ứng tiền</label>
                      <select
                        value={item.payerId}
                        onChange={(event) => updateReceiptDraftItem(item.id, { payerId: event.target.value })}
                        disabled={!item.selected || savingReceiptDraft}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                      >
                        <option value="">Người nhận chung</option>
                        {s.members.map((member) => (
                          <option key={member.id} value={member.id}>{member.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Người dùng</label>
                      <select
                        value={item.consumerMode}
                        onChange={(event) => setReceiptDraftConsumerMode(item.id, event.target.value as CostConsumerMode)}
                        disabled={!item.selected || savingReceiptDraft}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                      >
                        <option value="shared">Dùng chung</option>
                        <option value="specific">Chọn người dùng</option>
                        <option value="pending">Chưa rõ</option>
                      </select>
                    </div>
                  </div>

                  {item.consumerMode === "specific" && item.selected && (
                    <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {s.members.map((member) => {
                        const checked = item.consumerIds.includes(member.id);
                        return (
                          <label
                            key={member.id}
                            className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                              checked ? "border-green-300 bg-green-50 text-green-900" : "border-gray-200 bg-white text-gray-700"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleReceiptDraftConsumer(item.id, member.id)}
                              disabled={savingReceiptDraft}
                              className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-green-600 focus:ring-green-500"
                            />
                            <span className="truncate">{member.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-gray-500">Thành tiền</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(item.totalAmount)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
              <label className="font-medium text-gray-700">Giảm giá (phân bổ vào các món)</label>
              <Input
                value={receiptDiscount}
                onChange={(event) => setReceiptDiscount(event.target.value)}
                disabled={savingReceiptDraft}
                placeholder="0"
                type="number"
                min="0"
                step="1000"
                className="w-32 text-right"
              />
            </div>

            <div className="space-y-1 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-green-800">{receiptDraftSelectedItems.length} dòng được chọn</span>
                <span className={receiptDiscountValue > 0 ? "text-gray-500 line-through" : "font-bold text-green-800"}>
                  {formatCurrency(receiptDraftSelectedTotal)}
                </span>
              </div>
              {receiptDiscountValue > 0 && (
                <div className="flex items-center justify-between">
                  <span className="font-medium text-green-800">Sau giảm {formatCurrency(receiptDiscountValue)}</span>
                  <span className="font-bold text-green-800">{formatCurrency(receiptDraftAfterDiscount)}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setReceiptDraft(null)} disabled={savingReceiptDraft}>
                Hủy
              </Button>
              <Button onClick={handleAddReceiptDraftCosts} disabled={savingReceiptDraft || receiptDraftSelectedItems.length === 0}>
                {savingReceiptDraft ? "Đang thêm..." : "Thêm chi phí"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(bankDialogPayment)}
        onClose={() => {
          setBankDialogPayment(null);
          setBankOpenNotice("");
        }}
        title="Mở app ngân hàng"
      >
        {bankDialogPayment && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-gray-500">Số tiền</span>
                <span className="font-semibold text-gray-900">{formatCurrency(bankDialogPayment.amount)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-gray-500">Nội dung</span>
                <span className="truncate font-medium text-gray-900">{bankDialogPayment.note}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {BANK_DEEPLINK_OPTIONS.map((bank) => (
                <Button
                  key={bank.key}
                  variant="outline"
                  className="justify-start"
                  onClick={() => handleOpenBank(bank.key)}
                >
                  <Landmark size={16} className="mr-2 text-gray-500" />
                  <span className="truncate">{bank.name}</span>
                </Button>
              ))}
            </div>

            {bankOpenNotice && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                {bankOpenNotice}
              </div>
            )}

            <Button variant="outline" className="w-full" onClick={() => handleDownloadQr(bankDialogPayment)}>
              <Download size={16} className="mr-2" />
              Tải mã QR
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
