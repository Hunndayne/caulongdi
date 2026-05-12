import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import { Sidebar, BottomNav, Topbar } from "@/components/shared/Navbar";
import LoginPage from "@/pages/LoginPage";
import HomePage from "@/pages/HomePage";
import MembersPage from "@/pages/MembersPage";
import SessionsPage from "@/pages/SessionsPage";
import SessionDetailPage from "@/pages/SessionDetailPage";
import DebtPage from "@/pages/DebtPage";
import StatsPage from "@/pages/StatsPage";
import ProfilePage from "@/pages/ProfilePage";
import PublicProfilePage from "@/pages/PublicProfilePage";
import JoinPage from "@/pages/JoinPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-green-700 text-base font-bold text-white">
            TT
          </div>
          <div className="text-gray-500 text-sm">Đang tải...</div>
        </div>
      </div>
    );
  }
  if (!session) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isDashboard = location.pathname === "/";

  return (
    <div className="min-h-screen bg-[#f7f7f5]">
      <Sidebar />
      <div className="min-h-screen md:pl-[232px]">
        <Topbar />
        <main className="min-h-screen px-4 py-5 pb-28 sm:px-6 md:px-7 md:py-6 md:pb-12">
          <div className={isDashboard ? undefined : "mx-auto max-w-2xl"}>{children}</div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={
          <AuthGuard>
            <Layout>
              <Routes>
                <Route index element={<HomePage />} />
                <Route path="members" element={<MembersPage />} />
                <Route path="sessions" element={<SessionsPage />} />
                <Route path="sessions/:id" element={<SessionDetailPage />} />
                <Route path="debt" element={<DebtPage />} />
                <Route path="stats" element={<StatsPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="profiles/:id" element={<PublicProfilePage />} />
                <Route path="join/:code" element={<JoinPage />} />
              </Routes>
            </Layout>
          </AuthGuard>
        } />
      </Routes>
    </BrowserRouter>
  );
}
