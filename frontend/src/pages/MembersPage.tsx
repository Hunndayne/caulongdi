import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  UserCircle,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import { useSession } from "@/lib/auth-client";
import { useGroupsStore } from "@/stores/groupsStore";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/EmptyState";
import type { GroupInvite, GroupMember, GroupSearchResult } from "@/types";

export default function MembersPage() {
  const { data: session } = useSession();
  const {
    groups,
    activeGroupId,
    loading: loadingGroups,
    error: groupError,
    fetch: fetchGroups,
    createGroup,
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

  const currentUserId = (session?.user as { id?: string } | undefined)?.id;
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId),
    [groups, activeGroupId]
  );
  const canManageGroup = activeGroup?.role === "admin";

  useEffect(() => {
    fetchGroups();
    api.getReceivedGroupInvites().then(setReceivedInvites).catch(() => {});
  }, [fetchGroups]);

  useEffect(() => {
    if (!activeGroupId) {
      setMembers([]);
      setPendingInvites([]);
      return;
    }

    setMembersLoading(true);
    api.getGroupMembers(activeGroupId)
      .then(setMembers)
      .catch((err) => setError(err instanceof Error ? err.message : "Khong tai duoc thanh vien"))
      .finally(() => setMembersLoading(false));

    if (!canManageGroup) {
      setPendingInvites([]);
      return;
    }

    api.getGroupInvites(activeGroupId)
      .then(setPendingInvites)
      .catch((err) => setError(err instanceof Error ? err.message : "Khong tai duoc loi moi"));
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
        .catch((err) => setError(err instanceof Error ? err.message : "Khong tim duoc user"))
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
      setError(err instanceof Error ? err.message : "Khong tao duoc nhom");
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
      setError(err instanceof Error ? err.message : "Khong chap nhan duoc loi moi");
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
      setError(err instanceof Error ? err.message : "Khong tu choi duoc loi moi");
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
      setError(err instanceof Error ? err.message : "Khong gui duoc loi moi");
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
      setError(err instanceof Error ? err.message : "Khong huy duoc loi moi");
    } finally {
      setActingInviteId(null);
    }
  };

  const handleRemoveMember = async (member: GroupMember) => {
    if (!activeGroupId) return;
    if (!confirm(`Xoa ${member.name} khoi nhom ${activeGroup?.name}?`)) return;

    setActingUserId(member.userId);
    setError(null);
    try {
      await api.removeGroupMember(activeGroupId, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      await fetchGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Khong xoa duoc thanh vien");
    } finally {
      setActingUserId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <UserCircle size={20} className="text-green-600" />
        <h1 className="text-xl font-bold text-gray-900">Thanh vien va nhom</h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-gray-900">Nhom hien tai</div>
            <div className="text-sm text-gray-500">Chi thanh vien trong nhom moi xem duoc nhau.</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus size={16} className="mr-1.5" />
            Tao nhom
          </Button>
        </div>

        <select
          value={activeGroupId ?? ""}
          onChange={(event) => setActiveGroup(event.target.value || undefined)}
          disabled={loadingGroups || groups.length === 0}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          {groups.length === 0 ? (
            <option value="">Chua co nhom nao</option>
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
            <h2 className="font-semibold text-gray-900">Loi moi dang cho ban xac nhan</h2>
          </div>
          <div className="space-y-2">
            {receivedInvites.map((invite) => (
              <div key={invite.id} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900">{invite.groupName}</div>
                    <div className="text-sm text-gray-500">
                      Moi boi {invite.invitedByName} ({invite.invitedByEmail})
                    </div>
                  </div>
                  <Badge variant={invite.role === "admin" ? "green" : "gray"}>
                    {invite.role === "admin" ? "Moi lam admin" : "Moi vao nhom"}
                  </Badge>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleAcceptInvite(invite.id)}
                    disabled={actingInviteId === invite.id}
                  >
                    <Check size={15} className="mr-1.5" />
                    Chap nhan
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDeclineInvite(invite.id)}
                    disabled={actingInviteId === invite.id}
                  >
                    <X size={15} className="mr-1.5" />
                    Tu choi
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
            <h2 className="font-semibold text-gray-900">Moi them thanh vien</h2>
          </div>

          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Tim theo ten hoac email"
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
            <div className="text-sm text-gray-500">Nhap it nhat 2 ky tu de tim user.</div>
          ) : searchLoading ? (
            <div className="text-sm text-gray-500">Dang tim user...</div>
          ) : searchResults.length === 0 ? (
            <div className="text-sm text-gray-500">Khong tim thay user phu hop.</div>
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
                    {user.inviteStatus === "pending" ? "Da moi" : "Gui loi moi"}
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
            <h2 className="font-semibold text-gray-900">Loi moi dang cho</h2>
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
                    {invite.invitedUserEmail ?? "Dang cho xac nhan"}
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
                  aria-label="Huy loi moi"
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
            {activeGroup ? `Thanh vien trong ${activeGroup.name}` : "Thanh vien trong nhom"}
          </h2>
        </div>

        {!activeGroup ? (
          <EmptyState
            icon="👥"
            title="Chua chon nhom"
            description="Tao nhom moi hoac chap nhan mot loi moi de bat dau."
          />
        ) : membersLoading ? (
          <div className="text-center py-12 text-gray-400">Dang tai thanh vien...</div>
        ) : members.length === 0 ? (
          <EmptyState
            icon="👥"
            title="Chua co thanh vien"
            description="Them thanh vien bang loi moi, ho se vao nhom sau khi chap nhan."
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
                    aria-label="Xoa khoi nhom"
                  >
                    <UserMinus size={16} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} title="Tao nhom moi">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Ten nhom *</label>
            <Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Nhom cau long cuoi tuan" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Mo ta</label>
            <Input
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
              placeholder="Khu vuc, lich choi, san quen..."
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setCreateDialogOpen(false)}>
              Huy
            </Button>
            <Button className="flex-1" onClick={handleCreateGroup} disabled={creatingGroup || !groupName.trim()}>
              {creatingGroup ? "Dang tao..." : "Tao nhom"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
