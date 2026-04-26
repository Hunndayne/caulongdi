import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import { Sidebar, BottomNav } from "@/components/shared/Navbar";
import LoginPage from "@/pages/LoginPage";
import HomePage from "@/pages/HomePage";
import MembersPage from "@/pages/MembersPage";
import SessionsPage from "@/pages/SessionsPage";
import SessionDetailPage from "@/pages/SessionDetailPage";
import DebtPage from "@/pages/DebtPage";
import StatsPage from "@/pages/StatsPage";
import ProfilePage from "@/pages/ProfilePage";
import PublicProfilePage from "@/pages/PublicProfilePage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-3">🏸</div>
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
  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="sm:ml-56 pb-20 sm:pb-0 min-h-screen">
        <div className="max-w-2xl mx-auto px-4 py-5">{children}</div>
      </main>
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
              </Routes>
            </Layout>
          </AuthGuard>
        } />
      </Routes>
    </BrowserRouter>
  );
}
