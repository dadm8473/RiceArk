import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_USER_SEARCH_DEBOUNCE_MS,
  AdminUserResultCard,
  AdminUserResults,
  SelectedUserLookupState,
  SelectedUserContext,
  buildAdminUsersPath,
  retryAdminUsersPage,
  runAdminSubjectNavigationAttempt,
  runAdminSubjectTransition
} from "./AdminUserBoardsTab";
import type { AdminUserSummary } from "./types";

const user: AdminUserSummary = {
  id: "12345678-1234-1234-1234-123456789012",
  displayName: "Rice",
  provider: "discord",
  createdAt: "2026-07-01T00:00:00.000Z",
  recentActivityAt: "2026-07-30T00:00:00.000Z"
};

function render(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AdminUserBoardsTab", () => {
  it("shows approved user metadata without private identifiers", () => {
    const html = render(createElement(AdminUserResultCard, { user, onSelect: () => undefined }));

    expect(html).toContain("Rice");
    expect(html).toContain("Discord");
    expect(html).toContain("9012");
    expect(html).toContain("가입");
    expect(html).toContain("최근 활동");
    expect(html).not.toMatch(/email|providerUserId|provider user/i);
  });

  it("shows a persistent management context for the selected user", () => {
    const html = render(
      createElement(SelectedUserContext, {
        user,
        busy: false,
        onChooseAnother: () => undefined
      })
    );

    expect(html).toContain("관리 중: Rice");
    expect(html).toContain("다른 사용자 선택");
    expect(html).toContain("9012");
  });

  it("shows a recoverable direct-URL state when the selected user no longer exists", () => {
    const html = render(
      createElement(SelectedUserLookupState, {
        error: null,
        loading: false,
        resolved: true,
        onRetry: () => undefined,
        onChooseAnother: () => undefined
      })
    );

    expect(html).toContain("선택한 사용자를 찾을 수 없습니다.");
    expect(html).toContain("다른 사용자 선택");
  });

  it("renders loading, empty, error, retry, and next-page result states", () => {
    const loading = render(
      createElement(AdminUserResults, {
        users: [],
        loading: true,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        onSelect: () => undefined
      })
    );
    const empty = render(
      createElement(AdminUserResults, {
        users: [],
        loading: false,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        onSelect: () => undefined
      })
    );
    const error = render(
      createElement(AdminUserResults, {
        users: [],
        loading: false,
        loadingMore: false,
        error: "사용자 목록을 불러오지 못했습니다.",
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        onSelect: () => undefined
      })
    );
    const nextPage = render(
      createElement(AdminUserResults, {
        users: [user],
        loading: true,
        loadingMore: false,
        error: null,
        nextCursor: "next-page",
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        onSelect: () => undefined
      })
    );

    expect(loading).toContain("사용자를 불러오는 중");
    expect(empty).toContain("검색 결과가 없습니다");
    expect(error).toContain("사용자 목록을 불러오지 못했습니다.");
    expect(error).toContain("다시 시도");
    expect(nextPage).toContain("사용자 더 보기");
    expect(nextPage).toContain("disabled");
  });

  it("uses a 300 ms debounce and preserves direct selection and paging parameters", () => {
    expect(ADMIN_USER_SEARCH_DEBOUNCE_MS).toBe(300);
    expect(
      buildAdminUsersPath({
        search: " rice ",
        cursor: "cursor+/=",
        selectedUserId: user.id
      })
    ).toBe(
      `/api/admin/users?search=rice&cursor=cursor%2B%2F%3D&selectedUserId=${user.id}`
    );
  });

  it("retries the exact failed user page without replacing accumulated results", async () => {
    const loadUsers = vi.fn(async () => undefined);

    await retryAdminUsersPage(
      { cursor: "users-next-page", append: true },
      loadUsers
    );

    expect(loadUsers).toHaveBeenCalledOnce();
    expect(loadUsers).toHaveBeenCalledWith("users-next-page", true);
  });

  it("drains mutations and flushes pending writes before changing subjects", async () => {
    const events: string[] = [];

    await runAdminSubjectTransition({
      mode: "flush",
      waitForMutations: async () => {
        events.push("drain");
      },
      flushPendingWrites: async () => {
        events.push("flush");
      },
      retryPendingWrites: () => {
        events.push("retry");
      },
      discardPendingWrites: () => {
        events.push("discard");
      },
      changeSubject: () => {
        events.push("change");
      }
    });

    expect(events).toEqual(["drain", "flush", "change"]);
  });

  it("retries or explicitly discards the current subject queue before changing subjects", async () => {
    const retryPendingWrites = vi.fn();
    const flushPendingWrites = vi.fn(async () => undefined);
    const discardPendingWrites = vi.fn();
    const changeSubject = vi.fn();

    await runAdminSubjectTransition({
      mode: "retry",
      flushPendingWrites,
      retryPendingWrites,
      discardPendingWrites,
      changeSubject
    });
    expect(retryPendingWrites).toHaveBeenCalledOnce();
    expect(flushPendingWrites).toHaveBeenCalledOnce();
    expect(changeSubject).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    await runAdminSubjectTransition({
      mode: "discard",
      flushPendingWrites,
      retryPendingWrites,
      discardPendingWrites,
      changeSubject
    });
    expect(discardPendingWrites).toHaveBeenCalledOnce();
    expect(flushPendingWrites).not.toHaveBeenCalled();
    expect(changeSubject).toHaveBeenCalledOnce();
  });

  it("unlocks user A only after a superseded in-flight transition settles", async () => {
    const transition = deferred<void>();
    const unlock = vi.fn();
    let superseded = false;

    const result = runAdminSubjectNavigationAttempt({
      runTransition: () => transition.promise,
      isSuperseded: () => superseded,
      unlock
    });

    superseded = true;
    expect(unlock).not.toHaveBeenCalled();

    transition.resolve();

    await expect(result).resolves.toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
  });

  it("mounts useBoard only inside the selected-user child and scopes BoardOverview to the same client", () => {
    const source = readFileSync(new URL("./AdminUserBoardsTab.tsx", import.meta.url), "utf8");
    const childStart = source.indexOf("function SelectedUserBoard");
    const tabStart = source.indexOf("export function AdminUserBoardsTab");

    expect(childStart).toBeGreaterThan(-1);
    expect(tabStart).toBeGreaterThan(childStart);
    expect(source.slice(0, childStart)).not.toContain("useBoard(");
    expect(source.slice(childStart, tabStart)).toContain("useBoard({");
    expect(source).toContain("createApiClient({ adminTargetUserId: selectedUser.id })");
    expect(source).toMatch(/<BoardOverview[\s\S]*apiClient=\{apiClient\}/);
    expect(source.slice(childStart, tabStart)).toContain("onNavigationGuardChange(navigationGuard)");
  });
});
