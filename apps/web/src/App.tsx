import { useState } from "react";
import { apiPostNoContent } from "./api/client";
import { AuthMenu } from "./features/auth/AuthMenu";
import { useSession } from "./features/auth/useSession";
import { BoardOverview } from "./features/board/BoardOverview";
import { useBoard } from "./features/board/useBoard";
import { useDashboard } from "./features/dashboard/useDashboard";

export function getAuthErrorMessage(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("authError") !== "oauth_unavailable") return null;

  const provider = params.get("provider");
  const providerLabel = provider === "discord" ? "Discord" : provider === "google" ? "Google" : "로그인";
  return `${providerLabel} 로그인 설정이 아직 완료되지 않았습니다. 배포 환경에서 다시 시도해주세요.`;
}

export function App() {
  const { data, error } = useDashboard();
  const board = useBoard();
  const session = useSession();
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const authErrorMessage = typeof window === "undefined" ? null : getAuthErrorMessage(window.location.search);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <AuthMenu
          logoutPending={logoutPending}
          menuOpen={authMenuOpen}
          status={session.status}
          user={session.user}
          onLogout={handleLogout}
          onToggleMenu={() => setAuthMenuOpen((open) => !open)}
        />
      </header>
      <section className="workspace">
        {authErrorMessage ? <p className="error-text">{authErrorMessage}</p> : null}
        {session.status === "error" ? <p className="error-text">{session.error}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        {board.error && !error ? <p className="error-text">{board.error}</p> : null}
        {!data && !error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
        {data ? (
          <>
            {board.data ? <BoardOverview board={board.data} onBoardChanged={board.reload} /> : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
