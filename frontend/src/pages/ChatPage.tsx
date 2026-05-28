import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, MessageCircle, RefreshCw, Send, Users } from "lucide-react";
import { api } from "@/api/client";
import { Avatar } from "@/components/shared/Avatar";
import { GroupSelector } from "@/components/shared/GroupSelector";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useGroupsStore } from "@/stores/groupsStore";
import type { ChatMessage } from "@/types";

const AVATAR_COLORS = ["#16a34a", "#dc2626", "#2563eb", "#b45309", "#7c3aed", "#0891b2"];
const MAX_MESSAGE_LENGTH = 1000;

function colorForUser(userId: string) {
  let total = 0;
  for (let index = 0; index < userId.length; index += 1) {
    total += userId.charCodeAt(index);
  }
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map<string, ChatMessage>();
  [...current, ...incoming].forEach((message) => byId.set(message.id, message));
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function ChatEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[#e8e7e2] bg-white text-[#3f3f46]">
        <MessageCircle size={22} />
      </div>
      <h3 className="text-base font-semibold text-[#18181b]">{title}</h3>
      <p className="mt-1 max-w-[320px] text-sm text-[#71717a]">{description}</p>
    </div>
  );
}

export default function ChatPage() {
  const { data: session } = useSession();
  const currentUserId = (session?.user as { id?: string } | undefined)?.id;
  const { groups, activeGroupId, loading: groupsLoading } = useGroupsStore();
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId),
    [activeGroupId, groups]
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeGroupId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    const groupId = activeGroupId;
    let cancelled = false;

    async function loadInitialMessages() {
      setLoading(true);
      setError(null);
      try {
        const nextMessages = await api.getChatMessages(groupId);
        if (!cancelled) setMessages(nextMessages);
      } catch (err) {
        if (!cancelled) {
          setMessages([]);
          setError(err instanceof Error ? err.message : "Không tải được tin nhắn");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInitialMessages();
    const timer = window.setInterval(async () => {
      try {
        const nextMessages = await api.getChatMessages(groupId);
        if (!cancelled) setMessages((current) => mergeMessages(current, nextMessages));
      } catch {
        // Polling failures should not interrupt the conversation UI.
      }
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeGroupId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  async function refreshMessages() {
    if (!activeGroupId) return;
    setError(null);
    try {
      const nextMessages = await api.getChatMessages(activeGroupId);
      setMessages(nextMessages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được tin nhắn");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeGroupId || sending) return;

    const body = draft.trim();
    if (!body) return;

    setSending(true);
    setError(null);
    try {
      const sentMessage = await api.sendChatMessage(activeGroupId, body);
      setMessages((current) => mergeMessages(current, [sentMessage]));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được tin nhắn");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const canSend = Boolean(activeGroupId && draft.trim() && !sending);

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[560px] flex-col min-[769px]:h-[calc(100vh-112px)]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-normal text-[#18181b]">Chat</h1>
          <div className="mt-1 text-[13px] text-[#71717a]">
            {activeGroup ? activeGroup.name : "Chọn nhóm để bắt đầu"}
          </div>
        </div>
        <button
          type="button"
          onClick={refreshMessages}
          disabled={!activeGroupId}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-[#e8e7e2] bg-white text-[#3f3f46] transition-colors hover:bg-[#f7f7f5] disabled:cursor-not-allowed disabled:text-[#a1a1aa]"
          aria-label="Làm mới chat"
          title="Làm mới"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <GroupSelector />

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[#e8e7e2] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#efeeea] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#18181b] text-white">
              <MessageCircle size={18} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#18181b]">
                {activeGroup?.name ?? "Chưa chọn nhóm"}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#71717a]">
                <Users size={13} />
                <span>{activeGroup ? `${activeGroup.memberCount} thành viên` : "Không có nhóm"}</span>
              </div>
            </div>
          </div>
          <span className="rounded-full border border-[#e8e7e2] bg-[#f7f7f5] px-2.5 py-1 text-xs font-medium text-[#71717a]">
            {messages.length} tin nhắn
          </span>
        </div>

        {error && (
          <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle size={15} />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f7f5] px-3 py-4 min-[640px]:px-4">
          {groupsLoading ? (
            <div className="py-12 text-center text-sm text-[#71717a]">Đang tải...</div>
          ) : !activeGroupId ? (
            <ChatEmptyState title="Chưa có nhóm" description="Tạo hoặc tham gia một nhóm để mở phòng chat." />
          ) : loading && messages.length === 0 ? (
            <div className="py-12 text-center text-sm text-[#71717a]">Đang tải tin nhắn...</div>
          ) : messages.length === 0 ? (
            <ChatEmptyState title="Chưa có tin nhắn" description="Gửi lời chào đầu tiên cho nhóm." />
          ) : (
            <div className="space-y-3">
              {messages.map((message) => {
                const isMine = message.userId === currentUserId;
                return (
                  <div key={message.id} className={cn("flex gap-2", isMine ? "justify-end" : "justify-start")}>
                    {!isMine && (
                      <Avatar
                        name={message.user.name}
                        color={colorForUser(message.userId)}
                        imageUrl={message.user.avatarUrl}
                        size="sm"
                      />
                    )}
                    <div className={cn("flex max-w-[82%] min-w-0 flex-col", isMine ? "items-end" : "items-start")}>
                      <div className={cn("mb-1 flex max-w-full items-center gap-2 text-[11px] text-[#71717a]", isMine && "justify-end")}>
                        {!isMine && <span className="truncate font-semibold text-[#3f3f46]">{message.user.name}</span>}
                        <span className="shrink-0">{formatMessageTime(message.createdAt)}</span>
                      </div>
                      <div
                        className={cn(
                          "max-w-full whitespace-pre-wrap break-words px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-sm",
                          isMine
                            ? "rounded-2xl rounded-br-md bg-[#18181b] text-white"
                            : "rounded-2xl rounded-bl-md border border-[#e8e7e2] bg-white text-[#18181b]"
                        )}
                      >
                        {message.body}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-[#efeeea] bg-white p-3">
          <div className="flex items-end gap-2 rounded-[12px] border border-[#e8e7e2] bg-[#f7f7f5] p-2 focus-within:border-[#18181b]">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              onKeyDown={handleComposerKeyDown}
              disabled={!activeGroupId}
              placeholder={activeGroupId ? "Nhập tin nhắn..." : "Chọn nhóm để chat"}
              rows={1}
              className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-[#18181b] outline-none placeholder:text-[#a1a1aa] disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] bg-[#18181b] text-white transition-colors hover:bg-[#3f3f46] disabled:cursor-not-allowed disabled:bg-[#d4d4d8]"
              aria-label="Gửi tin nhắn"
              title="Gửi"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[#71717a]">
            <span className="truncate">{sending ? "Đang gửi..." : activeGroup?.name ?? "Chat nhóm"}</span>
            <span className="shrink-0">
              {draft.length}/{MAX_MESSAGE_LENGTH}
            </span>
          </div>
        </form>
      </section>
    </div>
  );
}
