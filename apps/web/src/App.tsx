import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Calculator, FileText } from "lucide-react";
import { apiPatch, apiPostNoContent } from "./api/client";
import { AdminDashboard } from "./features/admin/AdminDashboard";
import type {
  AdminBoardDurableControls,
  AdminBoardNavigationGuard,
  AdminBoardNavigationGuardChange,
  AdminTab
} from "./features/admin/types";
import { AuctionCalculatorModal } from "./features/auction-calculator/AuctionCalculatorModal";
import { AuthMenu, type AppTheme } from "./features/auth/AuthMenu";
import { useSession, type AuthUser } from "./features/auth/useSession";
import { BoardOverview } from "./features/board/BoardOverview";
import {
  createBoardMutationBarrier,
  type BoardMutationBarrier,
  type BoardMutationRunner
} from "./features/board/mutationBarrier";
import { useBoard } from "./features/board/useBoard";
import { PatchNotesModal } from "./features/patch-notes/PatchNotesModal";
import { SharedRiceBinPanel } from "./features/shared-rice-bin/SharedRiceBinPanel";

const SHARE_ID_PATH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ADMIN_TABS: readonly AdminTab[] = ["overview", "usage", "health", "data", "users", "audit"];

export type DurableLogoutMode = "normal" | "retry" | "discard";

type DurableBoardLogoutControls = Pick<
  AdminBoardDurableControls,
  | "waitForMutations"
  | "flushPendingWrites"
  | "retryPendingWrites"
  | "discardPendingWrites"
  | "reconcileAfterLogoutFailure"
  | "unlockMutations"
>;

export class DurableLogoutError extends Error {
  constructor(
    public readonly stage: "flush" | "logout",
    public readonly cause: unknown
  ) {
    super(`Durable logout failed during ${stage}`);
    this.name = "DurableLogoutError";
  }
}

export function getDurableLogoutFailureState(error: unknown): {
  logoutBlocked: boolean;
  logoutError: string | null;
} {
  if (error instanceof DurableLogoutError && error.stage === "flush") {
    return { logoutBlocked: true, logoutError: null };
  }
  return {
    logoutBlocked: false,
    logoutError: "로그아웃 요청에 실패했습니다. 다시 시도해주세요."
  };
}

export async function runDurableLogout({
  mode,
  waitForMutations,
  flushPendingWrites,
  retryPendingWrites,
  discardPendingWrites,
  logout
}: {
  mode: DurableLogoutMode;
  waitForMutations?: (() => Promise<void>) | undefined;
  flushPendingWrites: () => Promise<void>;
  retryPendingWrites: () => void;
  discardPendingWrites: () => void;
  logout: () => Promise<void>;
}): Promise<void> {
  try {
    await waitForMutations?.();
  } catch (error) {
    throw new DurableLogoutError("flush", error);
  }
  if (mode === "retry") retryPendingWrites();
  if (mode === "discard") {
    discardPendingWrites();
  } else {
    try {
      await flushPendingWrites();
    } catch (error) {
      throw new DurableLogoutError("flush", error);
    }
  }

  try {
    await logout();
  } catch (error) {
    throw new DurableLogoutError("logout", error);
  }
}

export async function recoverBoardAfterLogoutFailure(
  barrier: Pick<BoardMutationBarrier, "unlock">,
  board: { reconcileAfterLogoutFailure: () => Promise<unknown> },
  onRecovered?: (() => void) | undefined
): Promise<void> {
  try {
    await board.reconcileAfterLogoutFailure();
  } catch {
    // The existing board error surface reports reconciliation failures.
  } finally {
    barrier.unlock();
  }
  onRecovered?.();
}

async function settleBoardDurabilityOperations(
  operations: ReadonlyArray<() => Promise<unknown>>
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map(async (operation) => operation())
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more board durability operations failed");
  }
}

export async function runCrossBoardDurableLogoutAttempt({
  mode,
  boards,
  logout
}: {
  mode: DurableLogoutMode;
  boards: readonly DurableBoardLogoutControls[];
  logout: () => Promise<void>;
}): Promise<void> {
  try {
    await runDurableLogout({
      mode,
      waitForMutations: () => settleBoardDurabilityOperations(
        boards.map((board) => () => board.waitForMutations())
      ),
      flushPendingWrites: () => settleBoardDurabilityOperations(
        boards.map((board) => () => board.flushPendingWrites())
      ),
      retryPendingWrites: () => {
        boards.forEach((board) => board.retryPendingWrites());
      },
      discardPendingWrites: () => {
        boards.forEach((board) => board.discardPendingWrites());
      },
      logout
    });
  } catch (error) {
    await Promise.all(
      boards.map((board) => recoverBoardAfterLogoutFailure(
        { unlock: () => board.unlockMutations() },
        { reconcileAfterLogoutFailure: () => board.reconcileAfterLogoutFailure() }
      ))
    );
    throw error;
  }
}

export function getOwnerBoardInteractionProps(
  logoutPending: boolean,
  board: Pick<
    ReturnType<typeof useBoard>,
    "enqueueCellState" | "enqueueCompletion" | "markSheetStale" | "reload"
  >,
  runMutation: BoardMutationRunner
) {
  return {
    enqueueCellState: board.enqueueCellState,
    enqueueCompletion: board.enqueueCompletion,
    onBoardChanged: board.reload,
    onBoardSheetStale: board.markSheetStale,
    runMutation,
    writeLocked: logoutPending
  };
}

export function getSharedRiceBinInteractionProps(
  logoutPending: boolean,
  runMutation: BoardMutationRunner
) {
  return {
    runMutation,
    writeLocked: logoutPending
  };
}

export function getProfileBoardWriteState(
  ownerBoard: { hasPendingWrites: boolean; pendingWriteError: string | null },
  selectedAdminBoard: { hasPendingWrites: boolean; pendingWriteError: string | null } | null
): { hasPendingWrites: boolean; pendingWriteError: string | null } {
  const errors = [
    ownerBoard.pendingWriteError,
    selectedAdminBoard?.pendingWriteError ?? null
  ].filter((error): error is string => error !== null);
  return {
    hasPendingWrites:
      ownerBoard.hasPendingWrites ||
      (selectedAdminBoard?.hasPendingWrites ?? false),
    pendingWriteError: [...new Set(errors)].join(" ") || null
  };
}

export function getAuthErrorMessage(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("authError") !== "oauth_unavailable") return null;

  const provider = params.get("provider");
  const providerLabel = provider === "discord" ? "Discord" : provider === "google" ? "Google" : "로그인";
  return `${providerLabel} 로그인 설정이 아직 완료되지 않았습니다. 배포 환경에서 다시 시도해주세요.`;
}

export function getStoredAppTheme(storage: Pick<Storage, "getItem"> | null | undefined): AppTheme {
  try {
    const value = storage?.getItem("riceark-theme");
    return value === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function storeAppTheme(
  storage: Pick<Storage, "setItem"> | null | undefined,
  theme: AppTheme
): void {
  try {
    storage?.setItem("riceark-theme", theme);
  } catch {
    // Keep theme switching usable when browser storage is restricted.
  }
}

export function getAppThemeColor(theme: AppTheme): string {
  return theme === "dark" ? "#0f172a" : "#f4f6f8";
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
  adminTab: AdminTab | null;
  adminUserId: string | null;
  adminSheetId: string | null;
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

function getNonEmptyRouteId(value: string | null): string | null {
  const id = value?.trim();
  return id || null;
}

function getAdminTab(value: string | null): AdminTab | null {
  return ADMIN_TABS.includes(value as AdminTab) ? (value as AdminTab) : null;
}

export function getAppRouteState(href: string): AppRouteState {
  const url = new URL(href, "https://riceark.pages.dev");
  const shareId = getSharedRiceBinIdFromUrl(href);
  if (shareId) return { activeView: "shared", shareId, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null };

  const view = url.searchParams.get("view");
  if (view === "shared") return { activeView: "shared", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null };
  if (view === "admin") {
    return {
      activeView: "admin",
      shareId: null,
      sheetId: null,
      adminTab: getAdminTab(url.searchParams.get("adminTab")),
      adminUserId: getNonEmptyRouteId(url.searchParams.get("adminUser")),
      adminSheetId: getNonEmptyRouteId(url.searchParams.get("adminSheet"))
    };
  }

  const sheetId = url.searchParams.get("sheet");
  return {
    activeView: "board",
    shareId: null,
    sheetId: sheetId?.trim() ? sheetId : null,
    adminTab: null,
    adminUserId: null,
    adminSheetId: null
  };
}

export function getAppRouteUrl(route: AppRouteState, href: string): string {
  const url = new URL(href, "https://riceark.pages.dev");
  url.pathname = "/";
  url.searchParams.delete("view");
  url.searchParams.delete("share");
  url.searchParams.delete("sheet");
  url.searchParams.delete("adminTab");
  url.searchParams.delete("adminUser");
  url.searchParams.delete("adminSheet");

  if (route.activeView === "shared") {
    if (route.shareId) {
      url.searchParams.set("share", route.shareId);
    } else {
      url.searchParams.set("view", "shared");
    }
  } else if (route.activeView === "admin") {
    url.searchParams.set("view", "admin");
    if (route.adminTab) url.searchParams.set("adminTab", route.adminTab);
    if (route.adminUserId?.trim()) url.searchParams.set("adminUser", route.adminUserId);
    if (route.adminSheetId?.trim()) url.searchParams.set("adminSheet", route.adminSheetId);
  } else if (route.sheetId?.trim()) {
    url.searchParams.set("sheet", route.sheetId);
  }

  return getRelativeUrl(url);
}

export function getDirectSharedRiceBinHistoryUrls(href: string): [string, string] | null {
  const route = getAppRouteState(href);
  if (route.activeView !== "shared" || !route.shareId) return null;

  return [
    getAppRouteUrl({ activeView: "shared", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null }, href),
    getAppRouteUrl(route, href)
  ];
}

function getHistoryState(currentState: unknown): Record<string, unknown> {
  return currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? { ...(currentState as Record<string, unknown>), ricearkRoute: true }
    : { ricearkRoute: true };
}

export function shouldGuardAdminBoardNavigation(
  currentRoute: AppRouteState,
  nextRoute: AppRouteState
): boolean {
  return (
    currentRoute.activeView === "admin" &&
    currentRoute.adminTab === "users" &&
    currentRoute.adminUserId !== null &&
    (
      nextRoute.activeView !== "admin" ||
      nextRoute.adminTab !== "users" ||
      nextRoute.adminUserId !== currentRoute.adminUserId
    )
  );
}

export function App() {
  const session = useSession();
  const initialRouteRef = useRef<AppRouteState>(typeof window === "undefined" ? { activeView: "board", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null } : getAppRouteState(window.location.href));
  const currentRouteRef = useRef<AppRouteState>(initialRouteRef.current);
  const adminBoardNavigationGuardRef = useRef<AdminBoardNavigationGuard | null>(null);
  const pendingAdminBoardNavigationGuardRef = useRef<AdminBoardNavigationGuard | null>(null);
  const pendingGuardedPopstateRouteRef = useRef<AppRouteState | null>(null);
  const routeRequestIdRef = useRef(0);
  const seededSharedHistoryRef = useRef(false);
  const [routeShareId, setRouteShareId] = useState<string | null>(() => initialRouteRef.current.shareId);
  const [routeSheetId, setRouteSheetId] = useState<string | null>(() => initialRouteRef.current.sheetId);
  const [routeAdminTab, setRouteAdminTab] = useState<AdminTab | null>(() => initialRouteRef.current.adminTab);
  const [routeAdminUserId, setRouteAdminUserId] = useState<string | null>(() => initialRouteRef.current.adminUserId);
  const [routeAdminSheetId, setRouteAdminSheetId] = useState<string | null>(() => initialRouteRef.current.adminSheetId);
  const [activeView, setActiveView] = useState<AppView>(() => initialRouteRef.current.activeView);
  const [sharedRiceBinLookupResetKey, setSharedRiceBinLookupResetKey] = useState(0);
  const applyAppRoute = useCallback((
    route: AppRouteState,
    mode: "push" | "replace" | "pop" = "push"
  ) => {
    currentRouteRef.current = route;
    setActiveView(route.activeView);
    setRouteShareId(route.shareId);
    setRouteSheetId(route.sheetId);
    setRouteAdminTab(route.adminTab);
    setRouteAdminUserId(route.adminUserId);
    setRouteAdminSheetId(route.adminSheetId);
    if (typeof window === "undefined" || mode === "pop") return;

    const nextUrl = getAppRouteUrl(route, window.location.href);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;

    const historyMethod = mode === "replace" ? "replaceState" : "pushState";
    window.history[historyMethod](getHistoryState(window.history.state), "", nextUrl);
  }, []);
  const handleAdminBoardNavigationGuardChange = useCallback<AdminBoardNavigationGuardChange>((guard) => {
    adminBoardNavigationGuardRef.current = guard;
  }, []);
  const requestAppRoute = useCallback((
    route: AppRouteState,
    mode: "push" | "replace" | "pop" = "push"
  ): Promise<boolean> => {
    const requestId = ++routeRequestIdRef.current;
    const currentRoute = currentRouteRef.current;
    const guard = shouldGuardAdminBoardNavigation(currentRoute, route)
      ? adminBoardNavigationGuardRef.current
      : null;

    if (!guard) {
      pendingAdminBoardNavigationGuardRef.current?.supersede();
      pendingAdminBoardNavigationGuardRef.current = null;
      pendingGuardedPopstateRouteRef.current = null;
      applyAppRoute(route, mode);
      return Promise.resolve(true);
    }

    const pendingGuard = pendingAdminBoardNavigationGuardRef.current;
    if (pendingGuard && pendingGuard !== guard) pendingGuard.supersede();
    pendingAdminBoardNavigationGuardRef.current = guard;
    if (mode === "pop") {
      pendingGuardedPopstateRouteRef.current = currentRoute;
    }
    const restorePendingPopstateRoute = () => {
      const restoreRoute = pendingGuardedPopstateRouteRef.current;
      if (!restoreRoute || typeof window === "undefined") return;
      pendingGuardedPopstateRouteRef.current = null;
      const currentUrl = getAppRouteUrl(restoreRoute, window.location.href);
      window.history.pushState(
        getHistoryState(window.history.state),
        "",
        currentUrl
      );
    };

    let navigationDecision: Promise<boolean>;
    try {
      navigationDecision = guard();
    } catch {
      restorePendingPopstateRoute();
      return Promise.resolve(false);
    }

    return navigationDecision.then(
      (proceed) => {
        if (requestId !== routeRequestIdRef.current) return false;
        if (!proceed) {
          pendingAdminBoardNavigationGuardRef.current = null;
          restorePendingPopstateRoute();
          return false;
        }
        pendingAdminBoardNavigationGuardRef.current = null;
        pendingGuardedPopstateRouteRef.current = null;
        applyAppRoute(route, mode);
        return true;
      },
      () => {
        if (requestId === routeRequestIdRef.current) {
          pendingAdminBoardNavigationGuardRef.current = null;
          restorePendingPopstateRoute();
        }
        return false;
      }
    );
  }, [applyAppRoute]);
  const handleReplaceBoardSheetId = useCallback((sheetId: string | null) => {
    applyAppRoute({ activeView: "board", shareId: null, sheetId, adminTab: null, adminUserId: null, adminSheetId: null }, "replace");
  }, [applyAppRoute]);
  const isAuthenticated = session.status === "authenticated";
  const isAdmin = isAuthenticated && session.user.isAdmin === true;
  const isBoardEnabled = isAuthenticated && activeView === "board";
  const isBoardPollingEnabled = isBoardEnabled;
  const board = useBoard({
    enabled: isBoardEnabled,
    pollingEnabled: isBoardPollingEnabled,
    userId: isAuthenticated ? session.user.id : null,
    requestedSheetId: routeSheetId,
    onReplaceSheetId: handleReplaceBoardSheetId
  });
  const handleBoardSheetSelected = useCallback((sheetId: string) => {
    applyAppRoute({ activeView: "board", shareId: null, sheetId, adminTab: null, adminUserId: null, adminSheetId: null }, "push");
    void board.selectSheet(sheetId).catch(() => undefined);
  }, [applyAppRoute, board.selectSheet]);
  const boardMutationBarrierRef = useRef<BoardMutationBarrier | null>(null);
  if (!boardMutationBarrierRef.current) {
    boardMutationBarrierRef.current = createBoardMutationBarrier();
  }
  const boardMutationBarrier = boardMutationBarrierRef.current;
  const selectedAdminBoardControlsRef = useRef<AdminBoardDurableControls | null>(null);
  const [selectedAdminBoardWriteState, setSelectedAdminBoardWriteState] = useState<{
    hasPendingWrites: boolean;
    pendingWriteError: string | null;
  } | null>(null);
  const handleAdminBoardDurableControlsChange = useCallback((controls: AdminBoardDurableControls | null) => {
    selectedAdminBoardControlsRef.current = controls;
    setSelectedAdminBoardWriteState(controls
      ? {
          hasPendingWrites: controls.hasPendingWrites,
          pendingWriteError: controls.pendingWriteError
        }
      : null);
  }, []);
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [patchNotesOpen, setPatchNotesOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutBlocked, setLogoutBlocked] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(() =>
    getStoredAppTheme(typeof window === "undefined" ? null : window.localStorage)
  );
  const authErrorMessage = typeof window === "undefined" ? null : getAuthErrorMessage(window.location.search);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", getAppThemeColor(theme));
    storeAppTheme(window.localStorage, theme);
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
      void requestAppRoute(route, "pop");
      setCalculatorOpen(false);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [requestAppRoute]);

  useEffect(() => {
    if (activeView !== "admin" || session.status === "checking") return;
    if (!isAdmin) applyAppRoute({ activeView: "board", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null }, "replace");
  }, [activeView, isAdmin, session.status]);

  const attemptLogout = async (mode: DurableLogoutMode) => {
    const selectedAdminBoardControls = selectedAdminBoardControlsRef.current;
    const durableBoards: DurableBoardLogoutControls[] = [
      {
        waitForMutations: () => boardMutationBarrier.lockAndDrain(),
        flushPendingWrites: () => board.flushPendingWrites(),
        retryPendingWrites: () => board.retryPendingWrites(),
        discardPendingWrites: () => board.discardPendingWrites(),
        reconcileAfterLogoutFailure: () => board.reconcileAfterLogoutFailure(),
        unlockMutations: () => boardMutationBarrier.unlock()
      }
    ];
    if (selectedAdminBoardControls) durableBoards.push(selectedAdminBoardControls);
    setLogoutPending(true);
    setAuthMenuOpen(false);
    setLogoutBlocked(false);
    setLogoutError(null);
    try {
      await runCrossBoardDurableLogoutAttempt({
        mode,
        boards: durableBoards,
        logout: () => apiPostNoContent("/api/auth/logout")
      });
      window.location.assign("/");
    } catch (err) {
      const failure = getDurableLogoutFailureState(err);
      setLogoutPending(false);
      setAuthMenuOpen(true);
      setLogoutBlocked(failure.logoutBlocked);
      setLogoutError(failure.logoutError);
      console.error(err);
    }
  };

  const handleLogout = () => void attemptLogout("normal");
  const handleRetryLogout = () => void attemptLogout("retry");
  const handleDiscardLogout = () => void attemptLogout("discard");

  const handleThemeToggle = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

  const handleDisplayNameSave = async (displayName: string) => {
    const payload = await apiPatch<{ user: AuthUser }>("/api/profile", { displayName });
    session.updateUser(payload.user);
  };

  const clearSharedRiceBinEntryState = () => {
    applyAppRoute({ activeView: "shared", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null }, "replace");
  };

  const handleSharedBoardClosed = () => {
    clearSharedRiceBinEntryState();
  };

  const handleOwnBoardSelected = () => {
    setCalculatorOpen(false);
    void requestAppRoute({ activeView: "board", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null });
  };

  const handleSharedRiceBinSelected = () => {
    if (activeView === "shared") setSharedRiceBinLookupResetKey((key) => key + 1);
    setCalculatorOpen(false);
    void requestAppRoute({ activeView: "shared", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null });
  };

  const handleAdminSelected = () => {
    setCalculatorOpen(false);
    void requestAppRoute({ activeView: "admin", shareId: null, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null });
  };

  const handleAdminTabSelected = useCallback((adminTab: AdminTab) => {
    void requestAppRoute({
      activeView: "admin",
      shareId: null,
      sheetId: null,
      adminTab,
      adminUserId: routeAdminUserId,
      adminSheetId: routeAdminSheetId
    });
  }, [requestAppRoute, routeAdminSheetId, routeAdminUserId]);

  const handleAdminUserSelected = useCallback((adminUserId: string | null) => {
    void requestAppRoute({
      activeView: "admin",
      shareId: null,
      sheetId: null,
      adminTab: "users",
      adminUserId,
      adminSheetId: null
    });
  }, [requestAppRoute]);

  const handleAdminSheetSelected = useCallback((adminSheetId: string) => {
    applyAppRoute({
      activeView: "admin",
      shareId: null,
      sheetId: null,
      adminTab: "users",
      adminUserId: routeAdminUserId,
      adminSheetId
    });
  }, [applyAppRoute, routeAdminUserId]);

  const handleReplaceAdminSheetId = useCallback((adminSheetId: string | null) => {
    applyAppRoute({
      activeView: "admin",
      shareId: null,
      sheetId: null,
      adminTab: routeAdminTab ?? "users",
      adminUserId: routeAdminUserId,
      adminSheetId
    }, "replace");
  }, [applyAppRoute, routeAdminTab, routeAdminUserId]);

  const handleSharedBoardOpened = (shareId: string) => {
    applyAppRoute({ activeView: "shared", shareId, sheetId: null, adminTab: null, adminUserId: null, adminSheetId: null });
  };
  const profileBoardWriteState = getProfileBoardWriteState(board, selectedAdminBoardWriteState);

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
            hasPendingWrites={profileBoardWriteState.hasPendingWrites}
            logoutBlocked={logoutBlocked}
            logoutError={logoutError}
            logoutPending={logoutPending}
            menuOpen={authMenuOpen}
            status={session.status}
            theme={theme}
            user={session.user}
            pendingWriteError={profileBoardWriteState.pendingWriteError}
            onDisplayNameSave={handleDisplayNameSave}
            onDiscardLogout={handleDiscardLogout}
            onLogout={handleLogout}
            onRetryLogout={handleRetryLogout}
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
            <AdminDashboard
              activeTab={routeAdminTab}
              selectedUserId={routeAdminUserId}
              selectedSheetId={routeAdminSheetId}
              writeLocked={logoutPending}
              onDurableControlsChange={handleAdminBoardDurableControlsChange}
              onNavigationGuardChange={handleAdminBoardNavigationGuardChange}
              onTabSelected={handleAdminTabSelected}
              onUserSelected={handleAdminUserSelected}
              onSheetSelected={handleAdminSheetSelected}
              onReplaceSheetId={handleReplaceAdminSheetId}
            />
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
              {board.pendingWriteError ? (
                <p className="error-text board-write-error" role="alert">
                  변경사항 저장 오류: {board.pendingWriteError}
                </p>
              ) : null}
              {!board.data && !board.error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
              {board.data ? (
                <BoardOverview
                  activeSheetId={board.activeSheetId}
                  board={board.data}
                  onSheetSelected={handleBoardSheetSelected}
                  {...getOwnerBoardInteractionProps(logoutPending, board, boardMutationBarrier.run)}
                />
              ) : null}
            </>
          ) : null
        ) : (
          <SharedRiceBinPanel
            initialShareId={routeShareId}
            resetToLookupKey={sharedRiceBinLookupResetKey}
            sessionStatus={session.status}
            onSharedBoardClosed={handleSharedBoardClosed}
            onSharedBoardOpened={handleSharedBoardOpened}
            {...getSharedRiceBinInteractionProps(logoutPending, boardMutationBarrier.run)}
          />
        )}
      </section>
    </main>
  );
}
