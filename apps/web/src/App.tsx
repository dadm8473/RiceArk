import { useEffect, useRef, useState } from "react";
import { Activity, Calculator, FileText } from "lucide-react";
import { apiPatch, apiPostNoContent } from "./api/client";
import { AdminDashboard } from "./features/admin/AdminDashboard";
import { AuctionCalculatorModal } from "./features/auction-calculator/AuctionCalculatorModal";
import { AuthMenu, type AppTheme } from "./features/auth/AuthMenu";
import { useSession, type AuthUser } from "./features/auth/useSession";
import { BoardOverview } from "./features/board/BoardOverview";
import { useBoard } from "./features/board/useBoard";
import { PatchNotesModal } from "./features/patch-notes/PatchNotesModal";
import { SharedRiceBinPanel } from "./features/shared-rice-bin/SharedRiceBinPanel";

const SHARE_ID_PATH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

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

export type AppView = "board" | "shared" | "admin";

export interface AppRouteState {
  activeView: AppView;
  shareId: string | null;
  sheetId: string | null;
}

function getSharedRiceBinIdFromUrl(href: string): string | null {
  const url = new URL(href, "https://riceark.pages.dev");
  const queryShare = url.searchParams.get("share");
  if (queryShare && SHARE_ID_PATTERN.test(queryShare)) return queryShare;

  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathShare = pathParts.length === 2 && pathParts[0] === "shared" ? pathParts[1] : null;
  return pathShare && SHARE_ID_PATTERN.test(pathShare) ? pathShare : null;
}

function getRelativeUrl(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getAppRouteState(href: string): AppRouteState {
  const url = new URL(href, "https://riceark.pages.dev");
  const shareId = getSharedRiceBinIdFromUrl(href);
  if (shareId) return { activeView: "shared", shareId, sheetId: null };

  const view = url.searchParams.get("view");
  if (view === "shared") return { activeView: "shared", shareId: null, sheetId: null };
  if (view === "admin") return { activeView: "admin", shareId: null, sheetId: null };

  const sheetId = url.searchParams.get("sheet");
  return { activeView: "board", shareId: null, sheetId: sheetId?.trim() ? sheetId : null };
}

export function getAppRouteUrl(route: AppRouteState, href: string): string {
  const url = new URL(href, "https://riceark.pages.dev");
  url.pathname = "/";
  url.searchParams.delete("view");
  url.searchParams.delete("share");
  url.searchParams.delete("sheet");

  if (route.activeView === "shared") {
    if (route.shareId) {
      url.searchParams.set("share", route.shareId);
    } else {
      url.searchParams.set("view", "shared");
    }
  } else if (route.activeView === "admin") {
    url.searchParams.set("view", "admin");
  } else if (route.sheetId?.trim()) {
    url.searchParams.set("sheet", route.sheetId);
  }

  return getRelativeUrl(url);
}

export function getDirectSharedRiceBinHistoryUrls(href: string): [string, string] | null {
  const route = getAppRouteState(href);
  if (route.activeView !== "shared" || !route.shareId) return null;

  return [
    getAppRouteUrl({ activeView: "shared", shareId: null, sheetId: null }, href),
    getAppRouteUrl(route, href)
  ];
}

function getHistoryState(currentState: unknown): Record<string, unknown> {
  return currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? { ...(currentState as Record<string, unknown>), ricearkRoute: true }
    : { ricearkRoute: true };
}

export function App() {
  const session = useSession();
  const initialRouteRef = useRef<AppRouteState>(typeof window === "undefined" ? { activeView: "board", shareId: null, sheetId: null } : getAppRouteState(window.location.href));
  const seededSharedHistoryRef = useRef(false);
  const [routeShareId, setRouteShareId] = useState<string | null>(() => initialRouteRef.current.shareId);
  const [activeView, setActiveView] = useState<AppView>(() => initialRouteRef.current.activeView);
  const [sharedRiceBinLookupResetKey, setSharedRiceBinLookupResetKey] = useState(0);
  const isAuthenticated = session.status === "authenticated";
  const isAdmin = isAuthenticated && session.user.isAdmin === true;
  const isBoardEnabled = isAuthenticated && (activeView === "board" || activeView === "shared");
  const isBoardPollingEnabled = isAuthenticated && activeView === "board";
  const board = useBoard({ enabled: isBoardEnabled, pollingEnabled: isBoardPollingEnabled });
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [patchNotesOpen, setPatchNotesOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() =>
    getStoredAppTheme(typeof window === "undefined" ? null : window.localStorage)
  );
  const authErrorMessage = typeof window === "undefined" ? null : getAuthErrorMessage(window.location.search);

  const applyAppRoute = (route: AppRouteState, mode: "push" | "replace" = "push") => {
    setActiveView(route.activeView);
    setRouteShareId(route.shareId);
    if (typeof window === "undefined") return;

    const nextUrl = getAppRouteUrl(route, window.location.href);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;

    const historyMethod = mode === "replace" ? "replaceState" : "pushState";
    window.history[historyMethod](getHistoryState(window.history.state), "", nextUrl);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("riceark-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (seededSharedHistoryRef.current) return;
    const seededUrls = getDirectSharedRiceBinHistoryUrls(window.location.href);
    if (!seededUrls) return;

    seededSharedHistoryRef.current = true;
    window.history.replaceState(getHistoryState(window.history.state), "", seededUrls[0]);
    window.history.pushState(getHistoryState(window.history.state), "", seededUrls[1]);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function handlePopState() {
      const route = getAppRouteState(window.location.href);
      setActiveView(route.activeView);
      setRouteShareId(route.shareId);
      setCalculatorOpen(false);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (activeView !== "admin" || session.status === "checking") return;
    if (!isAdmin) applyAppRoute({ activeView: "board", shareId: null, sheetId: null }, "replace");
  }, [activeView, isAdmin, session.status]);

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
    applyAppRoute({ activeView: "shared", shareId: null, sheetId: null }, "replace");
  };

  const handleSharedBoardClosed = () => {
    clearSharedRiceBinEntryState();
  };

  const handleOwnBoardSelected = () => {
    setCalculatorOpen(false);
    applyAppRoute({ activeView: "board", shareId: null, sheetId: null });
  };

  const handleSharedRiceBinSelected = () => {
    if (activeView === "shared") setSharedRiceBinLookupResetKey((key) => key + 1);
    setCalculatorOpen(false);
    applyAppRoute({ activeView: "shared", shareId: null, sheetId: null });
  };

  const handleAdminSelected = () => {
    setCalculatorOpen(false);
    applyAppRoute({ activeView: "admin", shareId: null, sheetId: null });
  };

  const handleSharedBoardOpened = (shareId: string) => {
    applyAppRoute({ activeView: "shared", shareId, sheetId: null });
  };

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand-mark">
            <img aria-hidden="true" className="brand-icon" height="28" src="/icons/icon-192.png" width="28" alt="" />
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
            <button type="button" onClick={() => setPatchNotesOpen(true)}>
              <FileText aria-hidden="true" size={16} />
              패치노트
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
      {patchNotesOpen ? <PatchNotesModal isAdmin={isAdmin} onClose={() => setPatchNotesOpen(false)} /> : null}
      <section className="workspace">
        {authErrorMessage ? <p className="error-text">{authErrorMessage}</p> : null}
        {session.status === "error" ? <p className="error-text">{session.error}</p> : null}
        {activeView === "admin" ? (
          session.status === "checking" ? (
            <p>로그인 상태를 확인하는 중입니다.</p>
          ) : isAdmin ? (
            <AdminDashboard />
          ) : (
            <p>내 쌀통으로 이동하는 중입니다.</p>
          )
        ) : activeView === "board" ? (
          session.status === "checking" ? (
            <p>로그인 상태를 확인하는 중입니다.</p>
          ) : session.status === "anonymous" ? (
            <p>로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.</p>
          ) : session.status === "authenticated" ? (
            <>
              {board.error ? <p className="error-text">{board.error}</p> : null}
              {!board.data && !board.error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
              {board.data ? <BoardOverview board={board.data} onBoardChanged={board.reload} /> : null}
            </>
          ) : null
        ) : (
          <SharedRiceBinPanel
            initialShareId={routeShareId}
            ownerBoard={session.status === "authenticated" ? board.data : null}
            resetToLookupKey={sharedRiceBinLookupResetKey}
            sessionStatus={session.status}
            onSharedBoardClosed={handleSharedBoardClosed}
            onSharedBoardOpened={handleSharedBoardOpened}
            onOwnerBoardChanged={board.reload}
          />
        )}
      </section>
    </main>
  );
}
