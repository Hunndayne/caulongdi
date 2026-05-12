import { signIn } from "@/lib/auth-client";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

function TingTingLogo() {
  return (
    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true" className="h-11 w-11 shrink-0">
      <circle cx="22" cy="22" r="20" fill="currentColor" opacity=".14" />
      <circle cx="15" cy="16" r="7" fill="currentColor" opacity=".72" />
      <circle cx="29" cy="28" r="7" fill="currentColor" />
      <path d="M18.5 18.8L25.5 25.2" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity=".72" />
      <path d="M12 31V24H30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DecoRings() {
  return (
    <svg
      viewBox="0 0 420 420"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-20 -right-24 hidden w-[420px] text-white opacity-[.08] md:block"
    >
      <circle cx="210" cy="210" r="190" stroke="currentColor" strokeWidth="18" />
      <circle cx="210" cy="210" r="128" stroke="currentColor" strokeWidth="10" />
      <circle cx="210" cy="210" r="58" fill="currentColor" />
      <path d="M64 280C120 350 250 372 344 286" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
      <path d="M72 134C132 58 284 52 350 132" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
    </svg>
  );
}

function DecoPulse() {
  return (
    <svg
      viewBox="0 0 88 88"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute right-10 top-10 hidden w-20 text-white opacity-10 sm:block md:right-16 md:top-16"
    >
      <circle cx="44" cy="44" r="12" fill="currentColor" />
      <path d="M23 44C23 32.4 32.4 23 44 23" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <path d="M65 44C65 55.6 55.6 65 44 65" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <path d="M10 44C10 25.2 25.2 10 44 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path d="M78 44C78 62.8 62.8 78 44 78" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const redirect = searchParams.get("redirect");
  const callbackURL = redirect?.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      await signIn.social({ provider: "google", callbackURL });
    } catch {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="grid min-h-screen bg-[#f7f4ef] text-[#1a1916] md:grid-cols-2"
      style={{ fontFamily: "'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      <section className="relative flex overflow-hidden bg-[#1a3a2a] px-8 py-10 text-white sm:px-12 sm:py-12 md:min-h-screen md:items-center md:px-[72px] md:py-16">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <DecoRings />
        <DecoPulse />

        <div className="relative z-10 mx-auto w-full max-w-[420px] text-center sm:max-w-[460px] md:mx-0 md:text-left">
          <div className="mb-6 flex items-center justify-center gap-3.5 md:mb-12 md:justify-start">
            <TingTingLogo />
            <span className="text-lg font-bold tracking-[.2px]">TingTing</span>
          </div>

          <h1 className="text-[26px] font-bold leading-tight tracking-normal sm:text-3xl md:text-[clamp(28px,3vw,40px)]">
            Quản lý nhóm
            <br />
            thật dễ dàng.
            <span className="mt-2 block text-[.7em] font-normal text-white/45">
              Lịch nhóm · Thành viên · Quỹ chung
            </span>
          </h1>

          <p className="mx-auto mt-4 max-w-[340px] text-[13px] leading-7 text-white/45 md:mx-0 md:text-sm">
            TingTing giúp các nhóm tổ chức lịch hẹn, quản lý thành viên và theo dõi tài chính trong cùng một nơi.
          </p>
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-9 sm:px-10 md:min-h-screen md:py-12">
        <div className="w-full max-w-[360px]">
          <h2 className="text-2xl font-bold tracking-normal text-[#1a1916]">Đăng nhập</h2>
          <p className="mb-9 mt-1.5 text-sm leading-6 text-[#9a9590]">Dùng tài khoản Google để tiếp tục.</p>

          <button
            type="button"
            onClick={handleLogin}
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-3 rounded-xl border-[1.5px] border-[#e8e3da] bg-white px-5 py-[15px] text-[15px] font-semibold text-[#1a1916] shadow-[0_1px_4px_rgba(0,0,0,.06)] transition duration-200 hover:-translate-y-px hover:border-[#c8c0b4] hover:shadow-[0_4px_16px_rgba(0,0,0,.10)] active:translate-y-0 active:shadow-[0_1px_4px_rgba(0,0,0,.06)] disabled:pointer-events-none disabled:opacity-65"
          >
            {isLoading ? (
              <>
                <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#ddd] border-t-[#3d7a52]" />
                <span>Đang kết nối...</span>
              </>
            ) : (
              <>
                <GoogleIcon />
                <span>Đăng nhập với Google</span>
              </>
            )}
          </button>

          <p className="mt-7 text-center text-xs leading-5 text-[#9a9590]">
            Bằng cách đăng nhập, bạn đồng ý với{" "}
            <a href="#" className="text-[#3d7a52] hover:underline">
              Điều khoản sử dụng
            </a>{" "}
            và{" "}
            <a href="#" className="text-[#3d7a52] hover:underline">
              Chính sách bảo mật
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
