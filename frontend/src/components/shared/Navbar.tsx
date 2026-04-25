import { NavLink } from "react-router-dom";
import { Home, Users, Calendar, CreditCard, BarChart2 } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", icon: Home, label: "Trang chủ", exact: true },
  { to: "/sessions", icon: Calendar, label: "Buổi chơi" },
  { to: "/members", icon: Users, label: "Thành viên" },
  { to: "/debt", icon: CreditCard, label: "Công nợ" },
  { to: "/stats", icon: BarChart2, label: "Thống kê" },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40 sm:hidden">
      <div className="flex">
        {navItems.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn("flex-1 flex flex-col items-center py-2 gap-0.5 text-xs transition-colors",
                isActive ? "text-green-600" : "text-gray-500"
              )
            }
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden sm:flex w-56 flex-col fixed left-0 top-0 bottom-0 bg-white border-r border-gray-200 z-40">
      <div className="p-4 border-b">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🏸</span>
          <span className="font-bold text-green-700 text-lg">Cầu Lông Đội</span>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn("flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-green-50 text-green-700"
                  : "text-gray-600 hover:bg-gray-50"
              )
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
