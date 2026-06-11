import { useEffect, useState } from "react";
import { Activity, Calculator } from "lucide-react";
import { apiPatch, apiPostNoContent } from "./api/client";
import { AdminDashboard } from "./features/admin/AdminDashboard";
import { AuctionCalculatorModal } from "./features/auction-calculator/AuctionCalculatorModal";
import { AuthMenu, type AppTheme } from "./features/auth/AuthMenu";
import { useSession, type AuthUser } from "./features/auth/useSession";
import { BoardOverview } from "./features/board/BoardOverview";
import { useBoard } from "./features/board/useBoard";
import { extractSharedRiceBinId, SharedRiceBinPanel } from "./features/shared-rice-bin/SharedRiceBinPanel";

const SHARE_ID_PATH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function getAuthErrorMessage(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("authError") !== "oauth_unavailable") return null;

  const provider = params.get("provider");
  const providerLabel = provider === "discord" ? "Discord" : provider === "google" ? "Google" : "로그인";
  return `${providerLabel} 로그인 설정이 아직 완료되지 않았습니다. 배포 환경에서 다시 시도해주세요.`;
}

export function getStoredAppTheme(storage: Pick<Storage, "getItem"> | null | undefined): AppTheme {
  const value = storage?.getItem("riceark-theme");
  return value === "dark" ? "dark" : "light";
}

export function getUrlWithoutSharedRiceBinId(href: string): string {
  const url = new URL(href, "https://riceark.pages.dev");
  url.searchParams.delete("share");

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length === 2 && pathParts[0] === "shared" && SHARE_ID_PATH_PATTERN.test(pathParts[1] ?? "")) {
    url.pathname = "/";
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

type AppView = "board" | "shared" | "admin";

export function App() {
  const session = useSession();
  const [initialShareId, setInitialShareId] = useState(() => (typeof window === "undefined" ? null : extractSharedRiceBinId(window.location.href)));
  const [activeView, setActiveView] = useState<AppView>(() => (initialShareId ? "shared" : "board"));
  const isAdmin = session.status === "authenticated" && session.user.isAdmin === true;
  const isBoardEnabled = activeView === "board" || (activeView === "shared" && session.status === "authenticated");
  const board = useBoard({ enabled: isBoardEnabled });
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() =>
    getStoredAppTheme(typeof window === "undefined" ? null : window.localStorage)
  );
  const authErrorMessage = typeof window === "undefined" ? null : getAuthErrorMessage(window.location.search);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("riceark-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (activeView === "admin" && !isAdmin) setActiveView("board");
  }, [activeView, isAdmin]);

  const handleLogout = async () => {
    setLogoutPending(true);
    setAuthMenuOpen(false);
    try {
      await apiPostNoContent("/api/auth/logout");
      window.location.assign("/");
    } catch (err) {
      setLogoutPending(false);
      console.error(err);
    }
  };

  const handleThemeToggle = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

  const handleDisplayNameSave = async (displayName: string) => {
    const payload = await apiPatch<{ user: AuthUser }>("/api/profile", { displayName });
    session.updateUser(payload.user);
  };

  const clearSharedRiceBinEntryState = () => {
    setInitialShareId(null);
    if (typeof window === "undefined" || !extractSharedRiceBinId(window.location.href)) return;
    window.history.replaceState(window.history.state, "", getUrlWithoutSharedRiceBinId(window.location.href));
  };

  const handleSharedBoardClosed = () => {
    clearSharedRiceBinEntryState();
  };

  const handleOwnBoardSelected = () => {
    setActiveView("board");
    setCalculatorOpen(false);
    clearSharedRiceBinEntryState();
  };

  const handleSharedRiceBinSelected = () => {
    setActiveView("shared");
    setCalculatorOpen(false);
  };

  const handleAdminSelected = () => {
    setActiveView("admin");
    setCalculatorOpen(false);
    clearSharedRiceBinEntryState();
  };

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand-mark">
            <img aria-hidden="true" className="brand-icon" height="34" src="/icons/icon-192.png" width="34" alt="" />
            <h1>RiceArk</h1>
          </div>
          <nav className="app-nav" aria-label="주요 기능">
            <button className={activeView === "board" ? "active" : undefined} type="button" onClick={handleOwnBoardSelected}>
              내 쌀통
            </button>
            <button className={activeView === "shared" ? "active" : undefined} type="button" onClick={handleSharedRiceBinSelected}>
              공유 쌀통
            </button>
            <button type="button" onClick={() => setCalculatorOpen(true)}>
              <Calculator aria-hidden="true" size={16} />
              분배금 계산기
            </button>
            {isAdmin ? (
              <button className={activeView === "admin" ? "active" : undefined} type="button" onClick={handleAdminSelected}>
                <Activity aria-hidden="true" size={16} />
                운영 현황
              </button>
            ) : null}
          </nav>
        </div>
        <div className="topbar-secondary">
          <a className="button support-link" href="https://discord.gg/yanCxtrBTc" target="_blank" rel="noreferrer">
            문의하기
          </a>
          <AuthMenu
            logoutPending={logoutPending}
            menuOpen={authMenuOpen}
            status={session.status}
            theme={theme}
            user={session.user}
            onDisplayNameSave={handleDisplayNameSave}
            onLogout={handleLogout}
            onThemeToggle={handleThemeToggle}
            onToggleMenu={() => setAuthMenuOpen((open) => !open)}
          />
        </div>
      </header>
      {calculatorOpen ? <AuctionCalculatorModal onClose={() => setCalculatorOpen(false)} /> : null}
      <section className="workspace">
        {authErrorMessage ? <p className="error-text">{authErrorMessage}</p> : null}
        {session.status === "error" ? <p className="error-text">{session.error}</p> : null}
        {activeView === "admin" && isAdmin ? (
          <AdminDashboard />
        ) : activeView === "board" ? (
          <>
            {board.error ? <p className="error-text">{board.error}</p> : null}
            {!board.data && !board.error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
            {board.data ? <BoardOverview board={board.data} onBoardChanged={board.reload} /> : null}
          </>
        ) : (
          <SharedRiceBinPanel
            initialShareId={initialShareId}
            ownerBoard={session.status === "authenticated" ? board.data : null}
            sessionStatus={session.status}
            onSharedBoardClosed={handleSharedBoardClosed}
            onOwnerBoardChanged={board.reload}
          />
        )}
      </section>
    </main>
  );
}
