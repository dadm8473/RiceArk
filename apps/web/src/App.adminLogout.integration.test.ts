import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api/client";
import { App } from "./App";
import { createBoardMutationBarrier } from "./features/board/mutationBarrier";

const hooks = vi.hoisted(() => ({
  AdminDashboard: vi.fn(),
  AuthMenu: vi.fn(),
  useBoard: vi.fn(),
  useSession: vi.fn()
}));

vi.mock("./features/admin/AdminDashboard", () => ({
  AdminDashboard: (props: unknown) => {
    hooks.AdminDashboard(props);
    return "admin dashboard";
  }
}));

vi.mock("./features/auth/AuthMenu", () => ({
  AuthMenu: (props: unknown) => {
    hooks.AuthMenu(props);
    return "auth menu";
  }
}));

vi.mock("./features/auth/useSession", () => ({
  useSession: hooks.useSession
}));

vi.mock("./features/board/useBoard", () => ({
  useBoard: hooks.useBoard
}));

vi.mock("./features/board/BoardOverview", () => ({
  BoardOverview: () => "owner board"
}));

vi.mock("./features/shared-rice-bin/SharedRiceBinPanel", () => ({
  SharedRiceBinPanel: () => "shared board",
  extractSharedRiceBinId: () => null
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("selected administrator board logout integration", () => {
  beforeEach(() => {
    hooks.AdminDashboard.mockClear();
    hooks.AuthMenu.mockClear();
    hooks.useBoard.mockReset();
    hooks.useSession.mockReset();
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: {
        id: "admin-user",
        displayName: "Admin",
        avatarUrl: null,
        isAdmin: true
      },
      error: null,
      updateUser: vi.fn()
    });
    hooks.useBoard.mockReturnValue({
      activeSheetId: null,
      data: null,
      error: null,
      loading: false,
      reload: vi.fn(async () => null),
      reconcileAfterLogoutFailure: vi.fn(async () => null),
      selectSheet: vi.fn(async () => undefined),
      markSheetStale: vi.fn(async () => undefined),
      enqueueCompletion: vi.fn(),
      enqueueCellState: vi.fn(),
      flushPendingWrites: vi.fn(async () => undefined),
      retryPendingWrites: vi.fn(),
      discardPendingWrites: vi.fn(),
      hasPendingWrites: false,
      pendingWriteError: null
    });
    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelector: vi.fn(() => null)
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
        state: null
      },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn()
      },
      location: {
        assign: vi.fn(),
        hash: "",
        href: "https://riceark.pages.dev/?view=admin&adminTab=users&adminUser=12345678-1234-4abc-8def-123456789012",
        pathname: "/",
        search: "?view=admin&adminTab=users&adminUser=12345678-1234-4abc-8def-123456789012"
      },
      removeEventListener: vi.fn()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finishes a target-scoped PATCH before sending the auth logout request", async () => {
    const targetUserId = "12345678-1234-4abc-8def-123456789012";
    const patchResponse = deferred<Response>();
    const events: string[] = [];
    const fetchMock = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(path) === "/api/board/tables/table-1" && method === "PATCH") {
        events.push("target-patch:start");
        return patchResponse.promise;
      }
      if (String(path) === "/api/auth/logout" && method === "POST") {
        events.push("logout");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${String(path)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderToStaticMarkup(createElement(App));
    const dashboardProps = hooks.AdminDashboard.mock.lastCall?.[0] as {
      onDurableControlsChange?: (controls: unknown) => void;
    };
    const authMenuProps = hooks.AuthMenu.mock.lastCall?.[0] as {
      onLogout?: () => void;
    };
    const barrier = createBoardMutationBarrier();
    const scopedClient = createApiClient({ adminTargetUserId: targetUserId });
    const targetPatch = barrier.run(async () => {
      const result = await scopedClient.patch<{ ok: true }>(
        "/api/board/tables/table-1",
        { name: "Updated" }
      );
      events.push("target-patch:end");
      return result;
    });

    expect(dashboardProps.onDurableControlsChange).toBeTypeOf("function");
    dashboardProps.onDurableControlsChange?.({
      waitForMutations: barrier.lockAndDrain,
      flushPendingWrites: async () => {
        events.push("selected-flush");
      },
      retryPendingWrites: vi.fn(),
      discardPendingWrites: vi.fn(),
      reconcileAfterLogoutFailure: vi.fn(async () => null),
      unlockMutations: barrier.unlock,
      hasPendingWrites: true,
      pendingWriteError: null
    });
    authMenuProps.onLogout?.();

    await Promise.resolve();
    expect(events).toEqual(["target-patch:start"]);
    const patchInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(patchInit?.headers).get("X-RiceArk-Admin-Target-User")).toBe(targetUserId);

    patchResponse.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await targetPatch;
    await vi.waitFor(() => {
      expect(events).toEqual([
        "target-patch:start",
        "target-patch:end",
        "selected-flush",
        "logout"
      ]);
    });
  });
});
