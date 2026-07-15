import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  DurableLogoutError,
  getAppRouteState,
  getAppRouteUrl,
  getAuthErrorMessage,
  getDurableLogoutFailureState,
  getDirectSharedRiceBinHistoryUrls,
  getOwnerBoardInteractionProps,
  getUrlWithoutSharedRiceBinId,
  recoverBoardAfterLogoutFailure,
  runDurableLogout
} from "./App";
import { createBoardMutationBarrier } from "./features/board/mutationBarrier";
import { ReliablePatchQueueFlushError } from "./features/board/reliablePatchQueue";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<{
    callback: () => void | (() => void);
    dependencies: readonly unknown[] | undefined;
  }>,
  useBoard: vi.fn(),
  BoardOverview: vi.fn(),
  useSession: vi.fn()
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => {
      hooks.effects.push({ callback, dependencies });
    }
  };
});

vi.mock("./features/board/BoardOverview", () => ({
  BoardOverview: (props: unknown) => {
    hooks.BoardOverview(props);
    return "board overview";
  }
}));

vi.mock("./features/shared-rice-bin/SharedRiceBinPanel", () => ({
  SharedRiceBinPanel: () => "shared rice bin panel",
  extractSharedRiceBinId: () => null
}));

vi.mock("./features/admin/AdminDashboard", () => ({
  AdminDashboard: () => "admin dashboard"
}));

vi.mock("./features/dashboard/ChecklistMatrix", () => ({
  ChecklistMatrix: () => "legacy checklist matrix"
}));

vi.mock("./features/board/useBoard", () => ({
  useBoard: hooks.useBoard
}));

vi.mock("./features/auth/useSession", () => ({
  useSession: hooks.useSession
}));

const board = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [],
  tables: [],
  notes: [],
  axisItems: [],
  cellStates: [],
  completions: []
};

function installBrowserWindow(href: string) {
  const url = new URL(href);
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    history: {
      pushState: vi.fn(),
      replaceState,
      state: null
    },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    },
    location: {
      assign: vi.fn(),
      hash: url.hash,
      href: url.href,
      pathname: url.pathname,
      search: url.search
    },
    removeEventListener: vi.fn()
  });
  return { replaceState };
}

function runLatestEffect() {
  const effect = hooks.effects.at(-1);
  expect(effect).toBeDefined();
  effect?.callback();
  return effect;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("getAuthErrorMessage", () => {
  it("wraps login start errors in a Korean app message", () => {
    expect(getAuthErrorMessage("?authError=oauth_unavailable&provider=discord")).toBe(
      "Discord 로그인 설정이 아직 완료되지 않았습니다. 배포 환경에서 다시 시도해주세요."
    );
  });

  it("ignores normal URLs", () => {
    expect(getAuthErrorMessage("")).toBeNull();
  });
});

describe("getUrlWithoutSharedRiceBinId", () => {
  it("removes shared rice bin ids from query and path links while preserving the rest of the URL", () => {
    expect(getUrlWithoutSharedRiceBinId("https://riceark.pages.dev/?share=AbCdEfGhIjKlMnOpQrStUv&foo=1#memo")).toBe("/?foo=1#memo");
    expect(getUrlWithoutSharedRiceBinId("https://riceark.pages.dev/shared/AbCdEfGhIjKlMnOpQrStUv?foo=1")).toBe("/?foo=1");
  });
});

describe("app route helpers", () => {
  const shareId = "AbCdEfGhIjKlMnOpQrStUv";

  it("maps URL state to board, shared lookup, shared detail, and admin views", () => {
    expect(getAppRouteState("https://riceark.pages.dev/?sheet=sheet-2")).toEqual({
      activeView: "board",
      shareId: null,
      sheetId: "sheet-2"
    });
    expect(getAppRouteState("https://riceark.pages.dev/?view=shared")).toEqual({
      activeView: "shared",
      shareId: null,
      sheetId: null
    });
    expect(getAppRouteState(`https://riceark.pages.dev/?share=${shareId}`)).toEqual({
      activeView: "shared",
      shareId,
      sheetId: null
    });
    expect(getAppRouteState("https://riceark.pages.dev/?view=admin")).toEqual({
      activeView: "admin",
      shareId: null,
      sheetId: null
    });
  });

  it("builds client-side URLs while preserving unrelated query parameters", () => {
    const currentUrl = "https://riceark.pages.dev/?foo=1&share=old&sheet=old-sheet#memo";

    expect(getAppRouteUrl({ activeView: "board", shareId: null, sheetId: "sheet-2" }, currentUrl)).toBe("/?foo=1&sheet=sheet-2#memo");
    expect(getAppRouteUrl({ activeView: "shared", shareId: null, sheetId: null }, currentUrl)).toBe("/?foo=1&view=shared#memo");
    expect(getAppRouteUrl({ activeView: "shared", shareId, sheetId: null }, currentUrl)).toBe(`/?foo=1&share=${shareId}#memo`);
    expect(getAppRouteUrl({ activeView: "admin", shareId: null, sheetId: null }, currentUrl)).toBe("/?foo=1&view=admin#memo");
  });

  it("seeds direct shared detail links with a lookup history entry behind them", () => {
    expect(getDirectSharedRiceBinHistoryUrls(`https://riceark.pages.dev/?foo=1&share=${shareId}#memo`)).toEqual([
      "/?foo=1&view=shared#memo",
      `/?foo=1&share=${shareId}#memo`
    ]);
    expect(getDirectSharedRiceBinHistoryUrls("https://riceark.pages.dev/?view=shared")).toBeNull();
  });
});

describe("runDurableLogout", () => {
  it("maps flush and logout failures to distinct recovery UI states", () => {
    expect(getDurableLogoutFailureState(new DurableLogoutError("flush", new Error("offline"))))
      .toEqual({ logoutBlocked: true, logoutError: null });
    expect(getDurableLogoutFailureState(new DurableLogoutError("logout", new Error("unavailable"))))
      .toEqual({
        logoutBlocked: false,
        logoutError: "로그아웃 요청에 실패했습니다. 다시 시도해주세요."
      });
  });

  it("flushes pending writes before calling logout", async () => {
    const order: string[] = [];

    await runDurableLogout({
      mode: "normal",
      flushPendingWrites: async () => {
        order.push("flush");
      },
      retryPendingWrites: () => order.push("retry"),
      discardPendingWrites: () => order.push("discard"),
      logout: async () => {
        order.push("logout");
      }
    });

    expect(order).toEqual(["flush", "logout"]);
  });

  it("waits for admitted mutations before queues and auth logout", async () => {
    const mutationStep = deferred<void>();
    const order: string[] = [];
    const barrier = createBoardMutationBarrier();
    const activeMutation = barrier.run(async () => {
      order.push("mutation:start");
      await mutationStep.promise;
      order.push("mutation:end");
    });
    const mutationDrain = barrier.lockAndDrain();

    const logoutAttempt = runDurableLogout({
      mode: "normal",
      waitForMutations: () => mutationDrain,
      flushPendingWrites: async () => {
        order.push("flush");
      },
      retryPendingWrites: vi.fn(),
      discardPendingWrites: vi.fn(),
      logout: async () => {
        order.push("logout");
      }
    });

    await Promise.resolve();
    expect(order).toEqual(["mutation:start"]);
    mutationStep.resolve();
    await activeMutation;
    await logoutAttempt;
    expect(order).toEqual(["mutation:start", "mutation:end", "flush", "logout"]);
  });

  it("unlocks mutations and reconciles the board after logout failure", async () => {
    const barrier = createBoardMutationBarrier();
    await barrier.lockAndDrain();
    const reload = vi.fn(async () => null);

    await recoverBoardAfterLogoutFailure(barrier, reload);

    expect(reload).toHaveBeenCalledTimes(1);
    await expect(barrier.run(async () => "unlocked")).resolves.toBe("unlocked");
  });

  it("does not call logout when flushing fails", async () => {
    const logout = vi.fn(async () => undefined);

    await expect(
      runDurableLogout({
        mode: "normal",
        flushPendingWrites: async () => {
          throw new Error("offline");
        },
        retryPendingWrites: vi.fn(),
        discardPendingWrites: vi.fn(),
        logout
      })
    ).rejects.toMatchObject({ stage: "flush" });

    expect(logout).not.toHaveBeenCalled();
  });

  it("blocks logout when flushing reports a permanent rejection", async () => {
    const logout = vi.fn(async () => undefined);

    await expect(runDurableLogout({
      mode: "normal",
      flushPendingWrites: async () => {
        throw new ReliablePatchQueueFlushError("rejected", new Error("Locked row"));
      },
      retryPendingWrites: vi.fn(),
      discardPendingWrites: vi.fn(),
      logout
    })).rejects.toMatchObject({
      stage: "flush",
      cause: expect.objectContaining({ reason: "rejected" })
    });
    expect(logout).not.toHaveBeenCalled();
  });

  it("resumes queues before retrying the flush and logout", async () => {
    const order: string[] = [];

    await runDurableLogout({
      mode: "retry",
      retryPendingWrites: () => order.push("retry"),
      flushPendingWrites: async () => {
        order.push("flush");
      },
      discardPendingWrites: () => order.push("discard"),
      logout: async () => {
        order.push("logout");
      }
    });

    expect(order).toEqual(["retry", "flush", "logout"]);
  });

  it("discards only on the explicit discard path and still reports logout API failure", async () => {
    const discardPendingWrites = vi.fn();
    const logoutError = new Error("logout unavailable");

    await expect(
      runDurableLogout({
        mode: "discard",
        retryPendingWrites: vi.fn(),
        flushPendingWrites: vi.fn(async () => undefined),
        discardPendingWrites,
        logout: async () => {
          throw logoutError;
        }
      })
    ).rejects.toMatchObject({ stage: "logout", cause: logoutError });

    expect(discardPendingWrites).toHaveBeenCalledTimes(1);
  });
});

describe("App", () => {
  beforeEach(() => {
    hooks.effects.length = 0;
    hooks.useBoard.mockClear();
    hooks.BoardOverview.mockClear();
    hooks.useSession.mockClear();
    hooks.useBoard.mockReturnValue({
      data: board,
      error: null,
      reload: vi.fn(),
      enqueueCompletion: vi.fn(),
      enqueueCellState: vi.fn(),
      flushPendingWrites: vi.fn(async () => undefined),
      retryPendingWrites: vi.fn(),
      discardPendingWrites: vi.fn(),
      hasPendingWrites: false,
      pendingWriteError: null
    });
    hooks.useSession.mockReturnValue({ status: "anonymous", user: null, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the board builder as the only checklist surface on the main screen", () => {
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("board overview");
    expect(html).not.toContain("legacy checklist matrix");
  });

  it("shows pending write errors on the normal owner board screen", () => {
    hooks.useBoard.mockReturnValue({
      ...hooks.useBoard(),
      data: board,
      hasPendingWrites: true,
      pendingWriteError: "Completion locked"
    });
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Completion locked");
  });

  it("passes reliable write enqueue callbacks into the owner board", () => {
    const enqueueCompletion = vi.fn();
    const enqueueCellState = vi.fn();
    hooks.useBoard.mockReturnValue({
      ...hooks.useBoard(),
      data: board,
      enqueueCompletion,
      enqueueCellState
    });
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    renderToStaticMarkup(createElement(App));

    expect(hooks.BoardOverview).toHaveBeenCalledWith(
      expect.objectContaining({ enqueueCompletion, enqueueCellState, writeLocked: false })
    );
  });

  it("derives a real owner-board interaction lock while logout is pending", () => {
    const enqueueCompletion = vi.fn();
    const enqueueCellState = vi.fn();
    const reload = vi.fn();
    const runMutation = vi.fn();

    expect(getOwnerBoardInteractionProps(true, { enqueueCompletion, enqueueCellState, reload }, runMutation)).toEqual({
      enqueueCompletion,
      enqueueCellState,
      onBoardChanged: reload,
      runMutation,
      writeLocked: true
    });
  });

  it("does not load the legacy dashboard payload for the board-only main screen", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).not.toContain("useDashboard");
    expect(source).not.toContain("/api/dashboard");
  });

  it("renders the RiceArk icon in the top-left brand", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('src="/icons/icon-192.png"');
    expect(html).toContain('alt=""');
    expect(html.indexOf('class="brand-mark"')).toBeLessThan(html.indexOf("RiceArk"));
  });

  it("renders a shared rice bin entry beside the brand", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("공유 쌀통");
    expect(html.indexOf("RiceArk")).toBeLessThan(html.indexOf("공유 쌀통"));
  });

  it("renders the auction distribution calculator next to the main rice bin entries", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("분배금 계산기");
    expect(html.indexOf("공유 쌀통")).toBeLessThan(html.indexOf("분배금 계산기"));
  });

  it("renders a patch notes board entry next to the calculator", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("패치노트");
    expect(html.indexOf("분배금 계산기")).toBeLessThan(html.indexOf("패치노트"));
  });

  it("shows the operations dashboard entry only to admin users", () => {
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-admin", displayName: "수빈", avatarUrl: null, isAdmin: true },
      error: null
    });
    const adminHtml = renderToStaticMarkup(createElement(App));

    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-user", displayName: "쌀먹", avatarUrl: null, isAdmin: false },
      error: null
    });
    const userHtml = renderToStaticMarkup(createElement(App));

    expect(adminHtml).toContain("운영 현황");
    expect(adminHtml.indexOf("분배금 계산기")).toBeLessThan(adminHtml.indexOf("운영 현황"));
    expect(userHtml).not.toContain("운영 현황");
  });

  it("renders a support Discord link before the profile or login controls", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("문의하기");
    expect(html).toContain('href="https://discord.gg/yanCxtrBTc"');
    expect(html).toContain('target="_blank"');
    expect(html.indexOf("문의하기")).toBeLessThan(html.indexOf("Discord로 로그인"));
  });

  it("disables the owner board read and polling while the session is checking", () => {
    hooks.useSession.mockReturnValue({ status: "checking", user: null, error: null });

    renderToStaticMarkup(createElement(App));

    expect(hooks.useBoard).toHaveBeenLastCalledWith({ enabled: false, pollingEnabled: false, userId: null });
  });

  it("disables the owner board read and polling for anonymous sessions", () => {
    renderToStaticMarkup(createElement(App));

    expect(hooks.useBoard).toHaveBeenLastCalledWith({ enabled: false, pollingEnabled: false, userId: null });
  });

  it("renders a neutral session state instead of board loading while checking", () => {
    hooks.useBoard.mockReturnValue({ data: null, error: null, reload: vi.fn() });
    hooks.useSession.mockReturnValue({ status: "checking", user: null, error: null });

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("로그인 상태를 확인하는 중입니다.");
    expect(html).not.toContain("로스트아크 숙제 체크리스트를 불러오는 중입니다.");
  });

  it("renders authentication required instead of board loading for anonymous sessions", () => {
    hooks.useBoard.mockReturnValue({ data: null, error: null, reload: vi.fn() });

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.");
    expect(html).not.toContain("로스트아크 숙제 체크리스트를 불러오는 중입니다.");
  });

  it("renders the session error without a false board-loading state", () => {
    hooks.useBoard.mockReturnValue({ data: null, error: null, reload: vi.fn() });
    hooks.useSession.mockReturnValue({
      status: "error",
      user: null,
      error: "로그인 상태를 확인하지 못했습니다."
    });

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("로그인 상태를 확인하지 못했습니다.");
    expect(html).not.toContain("로스트아크 숙제 체크리스트를 불러오는 중입니다.");
  });

  it("enables the owner board read and polling for an authenticated own-board view", () => {
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    renderToStaticMarkup(createElement(App));

    expect(hooks.useBoard).toHaveBeenLastCalledWith({ enabled: true, pollingEnabled: true, userId: "user-1" });
  });

  it("retains the authenticated owner read without polling on the shared view", () => {
    installBrowserWindow("https://riceark.pages.dev/?view=shared");
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    renderToStaticMarkup(createElement(App));

    expect(hooks.useBoard).toHaveBeenLastCalledWith({ enabled: true, pollingEnabled: false, userId: "user-1" });
  });

  it("waits for session resolution before redirecting a non-admin direct admin route", () => {
    const checkingBrowser = installBrowserWindow("https://riceark.pages.dev/?view=admin");
    hooks.useSession.mockReturnValue({ status: "checking", user: null, error: null });

    const checkingHtml = renderToStaticMarkup(createElement(App));
    const checkingEffect = runLatestEffect();

    expect(checkingEffect?.dependencies).toEqual(["admin", false, "checking"]);
    expect(checkingBrowser.replaceState).not.toHaveBeenCalled();
    expect(checkingHtml).toContain("로그인 상태를 확인하는 중입니다.");
    expect(checkingHtml).not.toContain("shared rice bin panel");

    hooks.effects.length = 0;
    const resolvedBrowser = installBrowserWindow("https://riceark.pages.dev/?view=admin");
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-1", displayName: "RiceArk", avatarUrl: null, isAdmin: false },
      error: null
    });

    renderToStaticMarkup(createElement(App));
    const resolvedEffect = runLatestEffect();

    expect(resolvedEffect?.dependencies).toEqual(["admin", false, "authenticated"]);
    expect(resolvedEffect?.dependencies).not.toEqual(checkingEffect?.dependencies);
    expect(resolvedBrowser.replaceState).toHaveBeenCalledWith(expect.any(Object), "", "/");
  });

  it("keeps owner board work disabled on an authenticated admin direct route", () => {
    const browser = installBrowserWindow("https://riceark.pages.dev/?view=admin");
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-admin", displayName: "RiceArk Admin", avatarUrl: null, isAdmin: true },
      error: null
    });

    const html = renderToStaticMarkup(createElement(App));
    runLatestEffect();

    expect(hooks.useBoard).toHaveBeenLastCalledWith({ enabled: false, pollingEnabled: false, userId: "user-admin" });
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(html).toContain("admin dashboard");
    expect(html).not.toContain("shared rice bin panel");
  });

  it("clears shared rice bin link state when the user switches back to their own rice bin", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).toContain("const handleOwnBoardSelected = () =>");
    expect(source).toMatch(/handleOwnBoardSelected[\s\S]{0,220}applyAppRoute\(\{ activeView: "board", shareId: null, sheetId: null \}\)/);
    expect(source).toContain('onClick={handleOwnBoardSelected}');
  });

  it("turns a shared rice bin tab reselect into a lookup reset signal", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).toContain("sharedRiceBinLookupResetKey");
    expect(source).toMatch(/handleSharedRiceBinSelected[\s\S]{0,260}activeView === "shared"[\s\S]{0,260}setSharedRiceBinLookupResetKey/);
    expect(source).toContain("resetToLookupKey={sharedRiceBinLookupResetKey}");
  });
});

describe("app metadata", () => {
  it("links the web icon assets from the document head", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

    expect(html).toContain('rel="icon"');
    expect(html).toContain('href="/icons/favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/icons/icon-192.png"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/site.webmanifest"');
  });
});
