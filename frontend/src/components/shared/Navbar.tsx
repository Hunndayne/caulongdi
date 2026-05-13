import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart2,
  Calendar,
  ChevronRight,
  CreditCard,
  Home,
  LogOut,
  Search,
  UserCircle,
  Users,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { cn, getInitials } from "@/lib/utils";

const navItems = [
  { to: "/", icon: Home, label: "Trang chủ", exact: true },
  { to: "/sessions", icon: Calendar, label: "Buổi chơi" },
  { to: "/members", icon: Users, label: "Thành viên" },
  { to: "/debt", icon: CreditCard, label: "Công nợ" },
  { to: "/stats", icon: BarChart2, label: "Thống kê" },
  { to: "/profile", icon: UserCircle, label: "Hồ sơ" },
];

function useLogout() {
  const navigate = useNavigate();
  return async () => {
    try {
      await signOut();
    } finally {
      navigate("/login", { replace: true });
    }
  };
}

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#18181b] text-xs font-bold text-white shadow-sm",
        className
      )}
    >
      TT
    </span>
  );
}

function UserBubble({ size = "md" }: { size?: "sm" | "md" }) {
  const { data: session } = useSession();
  const user = session?.user as { name?: string; email?: string; image?: string; avatarUrl?: string } | undefined;
  const name = user?.name || "User";
  const imageUrl = user?.image || user?.avatarUrl;
  const sizeClass = size === "sm" ? "h-8 w-8 text-xs" : "h-9 w-9 text-sm";

  if (imageUrl) {
    return <img src={imageUrl} alt={name} className={cn(sizeClass, "rounded-full object-cover")} />;
  }

  return (
    <div
      className={cn(
        sizeClass,
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-zinc-300 to-zinc-500 font-bold text-white"
      )}
    >
      {getInitials(name)}
    </div>
  );
}

function currentLabel(pathname: string) {
  const match = navItems
    .filter((item) => (item.exact ? pathname === item.to : pathname.startsWith(item.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.label ?? "Trang chủ";
}

export function Topbar() {
  const location = useLocation();
  const { data: session } = useSession();
  const name = (session?.user as { name?: string } | undefined)?.name || "User";

  return (
    <>
      <header className="hidden h-[65px] items-center justify-between gap-4 border-b border-[#e8e7e2] bg-white px-7 min-[769px]:flex">
        <div className="flex items-center gap-2 text-[13px] text-[#71717a]">
          <Home size={14} />
          <span>TingTing</span>
          <ChevronRight size={14} />
          <span className="font-medium text-[#18181b]">{currentLabel(location.pathname)}</span>
        </div>

        <label className="flex w-[200px] items-center gap-2 rounded-[10px] border border-[#e8e7e2] bg-[#f7f7f5] px-3 py-2 text-[#71717a] min-[1100px]:w-[280px]">
          <Search size={14} />
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[#18181b] outline-none placeholder:text-[#a1a1aa]"
            placeholder="Tìm nhanh"
          />
          <kbd className="rounded border border-[#e8e7e2] bg-white px-1.5 py-0.5 text-[11px] text-[#71717a]">⌘K</kbd>
        </label>
      </header>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-[#e8e7e2] bg-white px-4 py-3 min-[769px]:hidden">
        <BrandMark />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold tracking-normal text-[#18181b]">TingTing</div>
          <div className="truncate text-xs text-[#71717a]">{name}</div>
        </div>
        <UserBubble size="sm" />
      </header>
    </>
  );
}

export function BottomNav() {
  return (
    <nav className="fixed before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:bg-[linear-gradient(180deg,rgba(255,255,255,.38)_0%,rgba(255,255,255,.05)_30%,rgba(255,255,255,.015)_66%,rgba(255,255,255,.14)_100%)] before:content-[''] bottom-6 left-1/2 z-40 w-[calc(100%-16px)] max-w-[420px] -translate-x-1/2 rounded-full border border-white/30 bg-white/[.025] p-[7px] shadow-[0_18px_52px_rgba(24,24,27,.12),0_4px_16px_rgba(24,24,27,.06),inset_0_1px_0_rgba(255,255,255,.55),inset_0_0_0_1px_rgba(255,255,255,.06),inset_0_-1px_0_rgba(24,24,27,.025)] backdrop-blur-[8px] backdrop-saturate-[210%] min-[390px]:w-[calc(100%-24px)] min-[769px]:hidden" aria-label="Điều hướng">
      <div className="relative flex h-[54px] items-center gap-px">
        {navItems.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn(
                "relative z-10 flex h-full min-w-10 flex-1 items-center justify-center gap-1.5 rounded-full px-1.5 text-[12.5px] font-semibold transition-all duration-300",
                isActive
                  ? "flex-[2.35] border border-white/45 bg-white/[.16] text-[#18181b] shadow-[0_8px_22px_rgba(24,24,27,.09),0_1px_4px_rgba(24,24,27,.05),inset_0_1px_0_rgba(255,255,255,.62),inset_0_-1px_0_rgba(24,24,27,.025)] backdrop-blur-[4px] [&_.bn-label]:max-w-[90px] [&_.bn-label]:opacity-100 [&_svg]:scale-[1.05]"
                  : "text-[#71717a] hover:text-[#18181b]"
              )
            }
          >
            <Icon size={18} className="shrink-0 transition-transform duration-300" />
            <span className="bn-label max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-300">
              {label}
            </span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function Sidebar() {
  const handleLogout = useLogout();
  const location = useLocation();
  const { data: session } = useSession();
  const user = session?.user as { name?: string; email?: string } | undefined;
  const activeIndex = Math.max(
    0,
    navItems.findIndex((item) => (item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to)))
  );

  return (
    <aside className="sticky top-0 z-40 hidden h-screen w-[232px] flex-col overflow-y-auto border-r border-[#e8e7e2] bg-[#f2f2ef] px-3.5 py-5 min-[769px]:flex">
      <div className="flex items-center gap-2.5 px-2 pb-[18px]">
        <BrandMark />
        <span className="text-base font-bold tracking-normal text-[#18181b]">TingTing</span>
      </div>

      <nav className="relative flex flex-1 flex-col gap-0.5 rounded-[18px] border border-white/60 bg-white/25 p-[7px] shadow-[0_14px_36px_rgba(24,24,27,.10),0_2px_8px_rgba(24,24,27,.05),inset_0_1px_0_rgba(255,255,255,.85)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-0 rounded-[18px] bg-gradient-to-b from-white/40 via-white/0 to-white/20" />
        <div
          className="pointer-events-none absolute left-[7px] right-[7px] z-0 h-[38px] rounded-[11px] border border-white/90 bg-white/55 shadow-[0_5px_14px_rgba(24,24,27,.12),0_1px_3px_rgba(24,24,27,.08),inset_0_1px_0_rgba(255,255,255,1)] transition-[top] duration-300"
          style={{ top: `${7 + activeIndex * 40}px` }}
        />
        {navItems.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn(
                "relative z-10 flex h-[38px] items-center gap-2.5 rounded-[11px] px-3 text-[13.5px] font-medium text-[#3f3f46] transition-all hover:text-[#18181b]",
                isActive &&
                  "font-semibold text-[#18181b] [&_svg]:scale-[1.06]"
              )
            }
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-[#e8e7e2] bg-white p-2">
        <UserBubble size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[#18181b]">{user?.name ?? "User"}</div>
          <div className="truncate text-[11px] text-[#71717a]">{user?.email ?? "Thành viên"}</div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-black/5 hover:text-[#18181b]"
          aria-label="Đăng xuất"
          title="Đăng xuất"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
