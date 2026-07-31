import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { ChevronDown, RefreshCw, Search, UserRound, UsersRound } from "lucide-react";
import {
  ApiClientError,
  apiGet,
  createApiClient
} from "../../api/client";
import { BoardOverview } from "../board/BoardOverview";
import {
  createBoardMutationBarrier,
  type BoardMutationBarrier
} from "../board/mutationBarrier";
import { useBoard } from "../board/useBoard";
import type {
  AdminBoardDurableControlsChange,
  AdminBoardNavigationGuard,
  AdminBoardNavigationGuardChange,
  AdminUserPage,
  AdminUserSummary
} from "./types";

export const ADMIN_USER_SEARCH_DEBOUNCE_MS = 300;

type AdminUserBoardsTabProps = {
  selectedUserId: string | null;
  selectedSheetId: string | null;
  writeLocked: boolean;
  onDurableControlsChange: AdminBoardDurableControlsChange;
  onNavigationGuardChange: AdminBoardNavigationGuardChange;
  onUserSelected: (userId: string | null) => void;
  onSheetSelected: (sheetId: string) => void;
  onReplaceSheetId: (sheetId: string | null) => void;
};

type AdminUserResultsProps = {
  users: AdminUserSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelect: (user: AdminUserSummary) => void;
};

type SubjectTransitionMode = "flush" | "retry" | "discard";

export type AdminUsersPageRequest = {
  cursor: string | null;
  append: boolean;
};

export function retryAdminUsersPage(
  request: AdminUsersPageRequest,
  loadUsers: (cursor: string | null, append: boolean) => Promise<void>
): Promise<void> {
  return loadUsers(request.cursor, request.append);
}

function formatAdminUserDate(value: string | null): string {
  if (!value) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}

function providerLabel(provider: string): string {
  if (provider === "discord") return "Discord";
  if (provider === "google") return "Google";
  return "기타";
}

function userIdSuffix(userId: string): string {
  return userId.slice(-4);
}

function getAdminUsersErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === "forbidden") {
    return "관리자 권한이 없습니다.";
  }
  if (error instanceof ApiClientError && error.code === "unauthorized") {
    return "로그인이 필요합니다.";
  }
  return "사용자 목록을 불러오지 못했습니다.";
}

function mergeUsers(
  current: AdminUserSummary[],
  incoming: AdminUserSummary[]
): AdminUserSummary[] {
  const users = new Map(current.map((user) => [user.id, user]));
  for (const user of incoming) users.set(user.id, user);
  return [...users.values()];
}

export function buildAdminUsersPath({
  search,
  cursor,
  selectedUserId
}: {
  search: string;
  cursor: string | null;
  selectedUserId: string | null;
}): string {
  const params = new URLSearchParams();
  const normalizedSearch = search.trim();
  if (normalizedSearch) params.set("search", normalizedSearch);
  if (cursor) params.set("cursor", cursor);
  if (selectedUserId) params.set("selectedUserId", selectedUserId);
  const query = params.toString();
  return `/api/admin/users${query ? `?${query}` : ""}`;
}

export async function runAdminSubjectTransition({
  mode,
  waitForMutations,
  flushPendingWrites,
  retryPendingWrites,
  discardPendingWrites,
  changeSubject
}: {
  mode: SubjectTransitionMode;
  waitForMutations?: (() => Promise<void>) | undefined;
  flushPendingWrites: () => Promise<void>;
  retryPendingWrites: () => void;
  discardPendingWrites: () => void;
  changeSubject: () => void | Promise<void>;
}): Promise<void> {
  await waitForMutations?.();
  if (mode === "retry") retryPendingWrites();
  if (mode === "discard") {
    discardPendingWrites();
  } else {
    await flushPendingWrites();
  }
  await changeSubject();
}

async function runAdminSubjectNavigationAttempt({
  runTransition,
  isSuperseded,
  unlock
}: {
  runTransition: () => Promise<void>;
  isSuperseded: () => boolean;
  unlock: () => void;
}): Promise<boolean> {
  try {
    await runTransition();
  } catch (error) {
    if (!isSuperseded()) throw error;
  }

  if (!isSuperseded()) return true;
  unlock();
  return false;
}

export type AdminSubjectNavigationController = {
  navigationGuard: AdminBoardNavigationGuard;
  attempt: (mode: SubjectTransitionMode) => Promise<void>;
  cancel: () => void;
  release: () => void;
};

export function createAdminSubjectNavigationController({
  runTransition,
  unlock,
  onPendingChange = () => undefined,
  onBlockedChange = () => undefined
}: {
  runTransition: (mode: SubjectTransitionMode) => Promise<void>;
  unlock: () => void;
  onPendingChange?: (pending: boolean) => void;
  onBlockedChange?: (blocked: boolean) => void;
}): AdminSubjectNavigationController {
  let currentRequest: {
    promise: Promise<boolean>;
    resolve: (proceed: boolean) => void;
  } | null = null;
  let superseded = false;
  let transitionInFlight = false;

  const resolveNavigation = (proceed: boolean) => {
    const request = currentRequest;
    if (!request) return;
    currentRequest = null;
    request.resolve(proceed);
  };

  const attempt = async (mode: SubjectTransitionMode) => {
    if (!currentRequest) return;
    transitionInFlight = true;
    onPendingChange(true);
    onBlockedChange(false);
    try {
      const proceed = await runAdminSubjectNavigationAttempt({
        runTransition: () => runTransition(mode),
        isSuperseded: () => superseded,
        unlock
      });
      resolveNavigation(proceed);
    } catch {
      onBlockedChange(true);
    } finally {
      transitionInFlight = false;
      onPendingChange(false);
    }
  };

  const requestNavigation = (): Promise<boolean> => {
    superseded = false;
    if (currentRequest) return currentRequest.promise;

    let resolve!: (proceed: boolean) => void;
    const promise = new Promise<boolean>((resolvePromise) => {
      resolve = resolvePromise;
    });
    currentRequest = { promise, resolve };
    void attempt("flush");
    return promise;
  };

  const supersedeNavigation = () => {
    if (!currentRequest) return;
    superseded = true;
    if (transitionInFlight) return;

    unlock();
    onBlockedChange(false);
    onPendingChange(false);
    resolveNavigation(false);
  };

  const navigationGuard = Object.assign(requestNavigation, {
    supersede: supersedeNavigation
  });

  const cancel = () => {
    if (transitionInFlight) {
      supersedeNavigation();
      return;
    }
    unlock();
    onBlockedChange(false);
    onPendingChange(false);
    resolveNavigation(false);
  };

  const release = () => {
    if (currentRequest) {
      supersedeNavigation();
    } else {
      unlock();
    }
  };

  return {
    navigationGuard,
    attempt,
    cancel,
    release
  };
}

export function AdminUserResultCard({
  user,
  onSelect
}: {
  user: AdminUserSummary;
  onSelect: (user: AdminUserSummary) => void;
}) {
  return (
    <article className="admin-user-result">
      <div className="admin-user-result-heading">
        <UserRound aria-hidden="true" size={18} />
        <div>
          <strong title={user.displayName}>{user.displayName}</strong>
          <span>
            {providerLabel(user.provider)} · ID 끝자리 {userIdSuffix(user.id)}
          </span>
        </div>
      </div>
      <dl className="admin-user-result-meta">
        <div>
          <dt>가입</dt>
          <dd>{formatAdminUserDate(user.createdAt)}</dd>
        </div>
        <div>
          <dt>최근 활동</dt>
          <dd>{formatAdminUserDate(user.recentActivityAt)}</dd>
        </div>
      </dl>
      <button className="secondary-button admin-user-select-button" type="button" onClick={() => onSelect(user)}>
        이 사용자 관리
      </button>
    </article>
  );
}

export function AdminUserResults({
  users,
  loading,
  loadingMore,
  error,
  nextCursor,
  onRetry,
  onLoadMore,
  onSelect
}: AdminUserResultsProps) {
  if (loading && users.length === 0) {
    return <p className="admin-management-state">사용자를 불러오는 중입니다.</p>;
  }

  if (error && users.length === 0) {
    return (
      <div className="admin-management-state error" role="alert">
        <p>{error}</p>
        <button className="secondary-button" type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={15} />
          다시 시도
        </button>
      </div>
    );
  }

  if (users.length === 0) {
    return <p className="admin-management-state">검색 결과가 없습니다.</p>;
  }

  return (
    <div className="admin-user-results">
      {users.map((user) => (
        <AdminUserResultCard key={user.id} user={user} onSelect={onSelect} />
      ))}
      {error ? (
        <div className="admin-management-state error compact" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" size={15} />
            다시 시도
          </button>
        </div>
      ) : null}
      {nextCursor ? (
        <button
          className="secondary-button admin-load-more-button"
          disabled={loading || loadingMore}
          type="button"
          onClick={onLoadMore}
        >
          <ChevronDown aria-hidden="true" size={16} />
          {loadingMore ? "불러오는 중" : "사용자 더 보기"}
        </button>
      ) : null}
    </div>
  );
}

export function SelectedUserContext({
  user,
  busy,
  onChooseAnother
}: {
  user: AdminUserSummary;
  busy: boolean;
  onChooseAnother: () => void;
}) {
  return (
    <div className="admin-user-context">
      <div>
        <strong title={user.displayName}>관리 중: {user.displayName}</strong>
        <span>
          {providerLabel(user.provider)} · ID 끝자리 {userIdSuffix(user.id)}
        </span>
      </div>
      <button className="secondary-button" disabled={busy} type="button" onClick={onChooseAnother}>
        <UsersRound aria-hidden="true" size={16} />
        다른 사용자 선택
      </button>
    </div>
  );
}

export function SelectedUserLookupState({
  error,
  loading,
  resolved,
  onRetry,
  onChooseAnother
}: {
  error: string | null;
  loading: boolean;
  resolved: boolean;
  onRetry: () => void;
  onChooseAnother: () => void;
}) {
  const missing = resolved && !loading && !error;
  return (
    <div className={`admin-management-state${error || missing ? " error" : ""}`} role={error || missing ? "alert" : undefined}>
      <p>
        {error
          ? "선택한 사용자 정보를 불러오지 못했습니다."
          : missing
            ? "선택한 사용자를 찾을 수 없습니다."
            : "선택한 사용자 정보를 확인하는 중입니다."}
      </p>
      {error || missing ? (
        <div className="admin-management-state-actions">
          <button className="secondary-button" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" size={15} />
            다시 시도
          </button>
          <button className="secondary-button" type="button" onClick={onChooseAnother}>
            다른 사용자 선택
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SelectedUserBoard({
  selectedUser,
  selectedSheetId,
  writeLocked,
  onDurableControlsChange,
  onNavigationGuardChange,
  onUserSelected,
  onSheetSelected,
  onReplaceSheetId
}: {
  selectedUser: AdminUserSummary;
  selectedSheetId: string | null;
  writeLocked: boolean;
  onDurableControlsChange: AdminBoardDurableControlsChange;
  onNavigationGuardChange: AdminBoardNavigationGuardChange;
  onUserSelected: (userId: string | null) => void;
  onSheetSelected: (sheetId: string) => void;
  onReplaceSheetId: (sheetId: string | null) => void;
}) {
  const apiClient = useMemo(
    () => createApiClient({ adminTargetUserId: selectedUser.id }),
    [selectedUser.id]
  );
  const board = useBoard({
    apiClient,
    userId: selectedUser.id,
    requestedSheetId: selectedSheetId,
    onReplaceSheetId
  });
  const mutationBarrierRef = useRef<BoardMutationBarrier | null>(null);
  if (!mutationBarrierRef.current) {
    mutationBarrierRef.current = createBoardMutationBarrier();
  }
  const mutationBarrier = mutationBarrierRef.current;
  const [transitionPending, setTransitionPending] = useState(false);
  const [transitionBlocked, setTransitionBlocked] = useState(false);
  const transitionActionsRef = useRef({
    discardPendingWrites: board.discardPendingWrites,
    flushPendingWrites: board.flushPendingWrites,
    retryPendingWrites: board.retryPendingWrites
  });
  transitionActionsRef.current = {
    discardPendingWrites: board.discardPendingWrites,
    flushPendingWrites: board.flushPendingWrites,
    retryPendingWrites: board.retryPendingWrites
  };

  const navigationControllerRef = useRef<AdminSubjectNavigationController | null>(null);
  if (!navigationControllerRef.current) {
    navigationControllerRef.current = createAdminSubjectNavigationController({
      runTransition: (mode) => {
        const actions = transitionActionsRef.current;
        return runAdminSubjectTransition({
          mode,
          waitForMutations: mutationBarrier.lockAndDrain,
          flushPendingWrites: actions.flushPendingWrites,
          retryPendingWrites: actions.retryPendingWrites,
          discardPendingWrites: actions.discardPendingWrites,
          changeSubject: () => undefined
        });
      },
      unlock: mutationBarrier.unlock,
      onPendingChange: setTransitionPending,
      onBlockedChange: setTransitionBlocked
    });
  }
  const navigationController = navigationControllerRef.current;

  const durableControls = useMemo(() => ({
    waitForMutations: mutationBarrier.lockAndDrain,
    flushPendingWrites: board.flushPendingWrites,
    retryPendingWrites: board.retryPendingWrites,
    discardPendingWrites: board.discardPendingWrites,
    reconcileAfterLogoutFailure: board.reconcileAfterLogoutFailure,
    unlockMutations: mutationBarrier.unlock,
    hasPendingWrites: board.hasPendingWrites,
    pendingWriteError: board.pendingWriteError
  }), [
    board.discardPendingWrites,
    board.flushPendingWrites,
    board.hasPendingWrites,
    board.pendingWriteError,
    board.reconcileAfterLogoutFailure,
    board.retryPendingWrites,
    mutationBarrier
  ]);

  useEffect(() => {
    onDurableControlsChange(durableControls);
    return () => onDurableControlsChange(null);
  }, [durableControls, onDurableControlsChange]);

  useEffect(() => {
    onNavigationGuardChange(navigationController.navigationGuard);
    return () => {
      onNavigationGuardChange(null);
      navigationController.release();
    };
  }, [navigationController, onNavigationGuardChange]);

  const cancelChange = () => {
    navigationController.cancel();
  };

  const handleSheetSelected = (sheetId: string) => {
    onSheetSelected(sheetId);
    void board.selectSheet(sheetId).catch(() => undefined);
  };

  return (
    <section className="admin-selected-user-board">
      <SelectedUserContext
        user={selectedUser}
        busy={writeLocked || transitionPending || transitionBlocked}
        onChooseAnother={() => onUserSelected(null)}
      />

      {transitionBlocked ? (
        <div className="admin-subject-switch-error" role="alert">
          <div>
            <strong>저장하지 못한 변경사항이 있습니다.</strong>
            <span>다시 저장하거나 변경사항을 버린 뒤 다른 사용자를 선택하세요.</span>
          </div>
          <div>
            <button className="secondary-button" disabled={transitionPending} type="button" onClick={cancelChange}>
              보드로 돌아가기
            </button>
            <button className="secondary-button" disabled={transitionPending} type="button" onClick={() => void navigationController.attempt("discard")}>
              변경사항 버리기
            </button>
            <button className="primary-button" disabled={transitionPending} type="button" onClick={() => void navigationController.attempt("retry")}>
              다시 저장
            </button>
          </div>
        </div>
      ) : null}

      {board.pendingWriteError && !transitionBlocked ? (
        <p className="admin-management-state error compact" role="alert">
          변경사항 저장 오류: {board.pendingWriteError}
        </p>
      ) : null}
      {board.error ? (
        <div className="admin-management-state error" role="alert">
          <p>{board.error}</p>
          <button className="secondary-button" type="button" onClick={() => void board.reload()}>
            <RefreshCw aria-hidden="true" size={15} />
            다시 시도
          </button>
        </div>
      ) : null}
      {!board.data && !board.error ? (
        <p className="admin-management-state">
          {board.loading ? "사용자 보드를 불러오는 중입니다." : "사용자 보드를 준비하는 중입니다."}
        </p>
      ) : null}
      {board.data ? (
        <div className="admin-user-board-area">
          <BoardOverview
            apiClient={apiClient}
            activeSheetId={board.activeSheetId}
            board={board.data}
            enqueueCellState={board.enqueueCellState}
            enqueueCompletion={board.enqueueCompletion}
            onBoardChanged={board.reload}
            onBoardSheetStale={board.markSheetStale}
            onSheetSelected={handleSheetSelected}
            runMutation={mutationBarrier.run}
            writeLocked={writeLocked || transitionPending || transitionBlocked}
          />
        </div>
      ) : null}
    </section>
  );
}

export function AdminUserBoardsTab({
  selectedUserId,
  selectedSheetId,
  writeLocked,
  onDurableControlsChange,
  onNavigationGuardChange,
  onUserSelected,
  onSheetSelected,
  onReplaceSheetId
}: AdminUserBoardsTabProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUserSummary | null>(null);
  const [selectionResolved, setSelectionResolved] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const failedRequestRef = useRef<AdminUsersPageRequest>({
    cursor: null,
    append: false
  });

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      ADMIN_USER_SEARCH_DEBOUNCE_MS
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  const loadUsers = useCallback(
    async (cursor: string | null, append: boolean) => {
      const requestId = ++requestIdRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setSelectionResolved(selectedUserId === null);
      }
      setError(null);

      try {
        const page = await apiGet<AdminUserPage>(
          buildAdminUsersPath({
            search: debouncedSearch,
            cursor,
            selectedUserId
          })
        );
        if (requestId !== requestIdRef.current) return;
        setUsers((current) => append ? mergeUsers(current, page.users) : page.users);
        setNextCursor(page.nextCursor);
        setSelectedUser(page.selectedUser);
        setSelectionResolved(true);
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return;
        failedRequestRef.current = { cursor, append };
        setError(getAdminUsersErrorMessage(loadError));
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [debouncedSearch, selectedUserId]
  );

  useEffect(() => {
    void loadUsers(null, false);
  }, [loadUsers]);

  const selectUser = (user: AdminUserSummary) => {
    setSelectedUser(user);
    onUserSelected(user.id);
  };

  if (selectedUserId && selectedUser?.id === selectedUserId) {
    return (
      <SelectedUserBoard
        selectedUser={selectedUser}
        selectedSheetId={selectedSheetId}
        writeLocked={writeLocked}
        onDurableControlsChange={onDurableControlsChange}
        onNavigationGuardChange={onNavigationGuardChange}
        onUserSelected={onUserSelected}
        onSheetSelected={onSheetSelected}
        onReplaceSheetId={onReplaceSheetId}
      />
    );
  }

  if (selectedUserId) {
    return (
      <section className="admin-user-management">
        <SelectedUserLookupState
          error={error}
          loading={loading}
          resolved={selectionResolved}
          onRetry={() => void retryAdminUsersPage(failedRequestRef.current, loadUsers)}
          onChooseAnother={() => onUserSelected(null)}
        />
      </section>
    );
  }

  return (
    <section className="admin-user-management">
      <div className="admin-user-search-toolbar">
        <div>
          <h3>사용자 검색</h3>
          <span>이름 또는 사용자 ID 끝자리</span>
        </div>
        <label className="admin-user-search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">사용자 검색어</span>
          <input
            type="search"
            value={search}
            placeholder="이름 또는 ID 끝자리 검색"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <AdminUserResults
        users={users}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        nextCursor={nextCursor}
        onRetry={() => void retryAdminUsersPage(failedRequestRef.current, loadUsers)}
        onLoadMore={() => void loadUsers(nextCursor, true)}
        onSelect={selectUser}
      />
    </section>
  );
}
