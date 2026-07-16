import { Copy, ExternalLink, Heart, Search, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiDelete, apiGet, apiPost } from "../../api/client";
import { BoardOverview } from "../board/BoardOverview";
import {
  type BoardMutationRunner,
  runBoardMutationDirect
} from "../board/mutationBarrier";
import type { BoardPayload } from "../board/types";
import type { SessionState } from "../auth/useSession";

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

interface BoardShareSummary {
  sheetId: string;
  sheetName: string;
  shareId: string;
  createdAt: string;
}

interface BoardShareFavoriteSummary extends BoardShareSummary {
  ownerDisplayName: string;
}

interface BoardSheetManifestSummary {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
}

interface BoardSharingOverview {
  sheets: BoardSheetManifestSummary[];
  shares: BoardShareSummary[];
  favorites: BoardShareFavoriteSummary[];
}

interface Props {
  initialShareId?: string | null | undefined;
  resetToLookupKey?: number | undefined;
  onSharedBoardClosed?: (() => void) | undefined;
  onSharedBoardOpened?: ((shareId: string) => void) | undefined;
  runMutation?: BoardMutationRunner | undefined;
  sessionStatus: SessionState["status"];
  writeLocked?: boolean | undefined;
}

export function runSharedRiceBinWrite<Result>(
  runMutation: BoardMutationRunner,
  operation: () => Promise<Result>,
  onError: (error: unknown) => void,
  onSettled: () => void
): Promise<Result> {
  return runMutation(async () => {
    try {
      return await operation();
    } catch (error) {
      onError(error);
      throw error;
    } finally {
      onSettled();
    }
  });
}

export function isSharedRiceBinWriteDisabled(
  writeLocked: boolean,
  pending: string | null,
  controlKey: string
): boolean {
  return writeLocked || pending === controlKey;
}

export function extractSharedRiceBinId(input: string): string | null {
  const value = input.trim();
  if (SHARE_ID_PATTERN.test(value)) return value;

  try {
    const url = new URL(value);
    const queryShare = url.searchParams.get("share");
    if (queryShare && SHARE_ID_PATTERN.test(queryShare)) return queryShare;
    const pathShare = url.pathname.split("/").filter(Boolean).at(-1);
    if (pathShare && SHARE_ID_PATTERN.test(pathShare)) return pathShare;
  } catch {
    const match = value.match(/[A-Za-z0-9_-]{22}/);
    if (match && SHARE_ID_PATTERN.test(match[0])) return match[0];
  }

  return null;
}

type SharedWindowLike = {
  opener: unknown;
} | null;

type SharedWindowOpen = (url: string, target: string, features: string) => SharedWindowLike;

export function buildSharedRiceBinLink(shareId: string, origin?: string): string {
  const resolvedOrigin = origin ?? (typeof window === "undefined" ? "https://riceark.pages.dev" : window.location.origin);
  return `${resolvedOrigin.replace(/\/$/, "")}/?share=${encodeURIComponent(shareId)}`;
}

export function openSharedRiceBinInNewTab(
  shareId: string,
  options: { open?: SharedWindowOpen; origin?: string } = {}
): boolean {
  const open = options.open ?? (typeof window === "undefined" ? null : (window.open.bind(window) as SharedWindowOpen));
  if (!open) return false;

  const opened = open(buildSharedRiceBinLink(shareId, options.origin), "_blank", "noopener,noreferrer");
  if (!opened) return false;

  try {
    opened.opener = null;
  } catch {
    // Some browsers expose opener as readonly when noopener is applied.
  }

  return true;
}

export function SharedRiceBinPanel({
  initialShareId,
  resetToLookupKey = 0,
  onSharedBoardClosed,
  onSharedBoardOpened,
  runMutation = runBoardMutationDirect,
  sessionStatus,
  writeLocked = false
}: Props) {
  const [lookupValue, setLookupValue] = useState(initialShareId ?? "");
  const [sharedBoard, setSharedBoard] = useState<BoardPayload | null>(null);
  const [sharedActiveSheetId, setSharedActiveSheetId] = useState<string | null>(null);
  const [overview, setOverview] = useState<BoardSharingOverview | null>(null);
  const [sharedBoardFavorite, setSharedBoardFavorite] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastResetToLookupKeyRef = useRef(resetToLookupKey);
  const lookupRequestRef = useRef(0);
  const favoriteStatusRequestRef = useRef<string | null>(null);
  const isAuthenticated = sessionStatus === "authenticated";
  const sheets = overview?.sheets ?? [];
  const shares = overview?.shares ?? [];
  const favorites = overview?.favorites ?? [];
  const shareBySheetId = useMemo(() => new Map(shares.map((share) => [share.sheetId, share])), [shares]);
  const favoriteShareIds = useMemo(() => new Set(favorites.map((favorite) => favorite.shareId)), [favorites]);

  async function loadFavoriteStatus(shareId: string) {
    if (!isAuthenticated) return;
    favoriteStatusRequestRef.current = shareId;
    const payload = await apiGet<{ favorite: boolean }>("/api/board/share-favorites/" + encodeURIComponent(shareId));
    if (favoriteStatusRequestRef.current === shareId) {
      setSharedBoardFavorite(payload.favorite);
    }
  }

  useEffect(() => {
    if (!isAuthenticated) {
      favoriteStatusRequestRef.current = null;
      setOverview(null);
      setSharedBoardFavorite(false);
      return;
    }
    if (initialShareId) return;
    let active = true;
    apiGet<BoardSharingOverview>("/api/board/sharing-overview")
      .then((payload) => {
        if (active) setOverview(payload);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "공유 쌀통 목록을 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, initialShareId]);

  const sharedBoardShareId = sharedBoard?.shareId ?? null;

  useEffect(() => {
    if (!isAuthenticated || !sharedBoardShareId) return;
    if (overview) {
      favoriteStatusRequestRef.current = null;
      setSharedBoardFavorite(favoriteShareIds.has(sharedBoardShareId));
      return;
    }
    if (favoriteStatusRequestRef.current === sharedBoardShareId) return;
    void loadFavoriteStatus(sharedBoardShareId).catch((err) => {
      setError(err instanceof Error ? err.message : "즐겨찾기 상태를 불러오지 못했습니다.");
    });
  }, [favoriteShareIds, isAuthenticated, overview, sharedBoardShareId]);

  useEffect(() => {
    if (!initialShareId) {
      favoriteStatusRequestRef.current = null;
      setSharedBoard(null);
      setSharedActiveSheetId(null);
      setSharedBoardFavorite(false);
      return;
    }
    if (sharedBoard?.shareId === initialShareId) return;
    void handleLookup(initialShareId, { syncHistory: false });
  }, [initialShareId]);

  useEffect(() => {
    if (lastResetToLookupKeyRef.current === resetToLookupKey) return;
    lastResetToLookupKeyRef.current = resetToLookupKey;
    if (!sharedBoard) return;
    setSharedBoard(null);
    setSharedActiveSheetId(null);
    onSharedBoardClosed?.();
  }, [resetToLookupKey, sharedBoard, onSharedBoardClosed]);

  async function handleLookup(rawInput = lookupValue, options: { syncHistory?: boolean } = {}) {
    const shareId = extractSharedRiceBinId(rawInput);
    if (!shareId) {
      setError("공유 쌀통 아이디 또는 링크를 확인해주세요.");
      return;
    }
    setPending("lookup");
    setError(null);
    setMessage(null);
    favoriteStatusRequestRef.current = null;
    const requestId = ++lookupRequestRef.current;
    try {
      const payload = await apiGet<BoardPayload>("/api/shared-rice-bins/" + encodeURIComponent(shareId));
      if (requestId !== lookupRequestRef.current) return;
      setSharedBoard({ ...payload, readOnly: true });
      setSharedActiveSheetId(
        payload.sheets.find((sheet) => sheet.is_default === 1)?.id ?? payload.sheets[0]?.id ?? null
      );
      setSharedBoardFavorite(favoriteShareIds.has(shareId));
      setLookupValue(shareId);
      if (options.syncHistory ?? true) onSharedBoardOpened?.(shareId);
      if (!overview) await loadFavoriteStatus(shareId);
    } catch (err) {
      if (requestId !== lookupRequestRef.current) return;
      setSharedBoard(null);
      setSharedActiveSheetId(null);
      setSharedBoardFavorite(false);
      setError(err instanceof Error ? err.message : "공유 쌀통을 불러오지 못했습니다.");
    } finally {
      if (requestId === lookupRequestRef.current) setPending(null);
    }
  }

  function handleLookupNewTab(rawInput = lookupValue) {
    const shareId = extractSharedRiceBinId(rawInput);
    if (!shareId) {
      setError("공유 쌀통 아이디 또는 링크를 확인해주세요.");
      return;
    }

    setError(null);
    setMessage(null);
    setLookupValue(shareId);
    if (!openSharedRiceBinInNewTab(shareId)) {
      setError("새 탭을 열지 못했습니다. 브라우저 팝업 차단 설정을 확인해주세요.");
    }
  }

  async function handleShareStart(sheetId: string) {
    return runSharedRiceBinWrite(
      runMutation,
      async () => {
        setPending(`share:${sheetId}`);
        setError(null);
        const created = await apiPost<{ shareId: string }>("/api/board/sheets/" + encodeURIComponent(sheetId) + "/share", {});
        setOverview((current) => {
          if (!current) return current;
          const sheet = current.sheets.find((sheet) => sheet.id === sheetId);
          if (!sheet) return current;
          const previousShareIds = new Set(
            current.shares
              .filter((share) => share.sheetId === sheetId)
              .map((share) => share.shareId)
          );
          const nextShare: BoardShareSummary = {
            sheetId,
            sheetName: sheet.name,
            shareId: created.shareId,
            createdAt: new Date().toISOString()
          };
          return {
            ...current,
            shares: [...current.shares.filter((share) => share.sheetId !== sheetId), nextShare],
            favorites: current.favorites.filter(
              (favorite) =>
                favorite.sheetId !== sheetId &&
                !previousShareIds.has(favorite.shareId)
            )
          };
        });
        setMessage("공유 아이디를 새로 만들었습니다.");
        await copyText(buildSharedRiceBinLink(created.shareId));
      },
      (err) => setError(err instanceof Error ? err.message : "공유를 시작하지 못했습니다."),
      () => setPending(null)
    );
  }

  async function handleShareStop(sheetId: string) {
    return runSharedRiceBinWrite(
      runMutation,
      async () => {
        setPending(`share:${sheetId}`);
        setError(null);
        await apiDelete("/api/board/sheets/" + encodeURIComponent(sheetId) + "/share");
        setOverview((current) => {
          if (!current) return current;
          const stoppedShareIds = new Set(
            current.shares
              .filter((share) => share.sheetId === sheetId)
              .map((share) => share.shareId)
          );
          return {
            ...current,
            shares: current.shares.filter((share) => share.sheetId !== sheetId),
            favorites: current.favorites.filter(
              (favorite) =>
                favorite.sheetId !== sheetId &&
                !stoppedShareIds.has(favorite.shareId)
            )
          };
        });
        setMessage("공유를 중단했습니다. 기존 링크는 더 이상 열리지 않습니다.");
      },
      (err) => setError(err instanceof Error ? err.message : "공유를 중단하지 못했습니다."),
      () => setPending(null)
    );
  }

  async function handleFavoriteToggle(shareId: string) {
    if (!isAuthenticated) return;
    return runSharedRiceBinWrite(
      runMutation,
      async () => {
        setPending(`favorite:${shareId}`);
        setError(null);
        const isFavorite = sharedBoard?.shareId === shareId ? sharedBoardFavorite : favoriteShareIds.has(shareId);
        if (isFavorite) {
          await apiDelete("/api/board/share-favorites/" + encodeURIComponent(shareId));
          setSharedBoardFavorite(false);
          setOverview((current) => current ? {
            ...current,
            favorites: current.favorites.filter((favorite) => favorite.shareId !== shareId)
          } : current);
        } else {
          const created = await apiPost<{ shareId: string }>("/api/board/share-favorites", { shareId });
          setSharedBoardFavorite(true);
          setOverview((current) => {
            if (!current || current.favorites.some((favorite) => favorite.shareId === created.shareId)) return current;
            const existingShare = current.shares.find((share) => share.shareId === created.shareId);
            const defaultSheet = sharedBoard?.sheets.find((sheet) => sheet.is_default === 1) ?? sharedBoard?.sheets[0];
            const favorite: BoardShareFavoriteSummary = existingShare
              ? { ...existingShare, ownerDisplayName: "내 쌀통" }
              : {
                  shareId: created.shareId,
                  sheetId: defaultSheet?.id ?? created.shareId,
                  sheetName: defaultSheet?.name ?? "공유 쌀통",
                  ownerDisplayName: "공유 쌀통",
                  createdAt: new Date().toISOString()
                };
            return {
              ...current,
              favorites: [favorite, ...current.favorites]
            };
          });
        }
      },
      (err) => setError(err instanceof Error ? err.message : "즐겨찾기를 저장하지 못했습니다."),
      () => setPending(null)
    );
  }

  function handleLookupSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleLookup();
  }

  function handleSharedBoardClose() {
    favoriteStatusRequestRef.current = null;
    setSharedBoard(null);
    setSharedActiveSheetId(null);
    setSharedBoardFavorite(false);
    onSharedBoardClosed?.();
  }

  if (sharedBoard) {
    return (
      <section className="shared-rice-bin-panel" aria-label="공유 쌀통">
        {error ? <p className="error-text">{error}</p> : null}
        {message ? <p className="shared-rice-bin-message">{message}</p> : null}
        {writeLocked ? <p role="status">로그아웃 중에는 공유 설정을 변경할 수 없습니다.</p> : null}

        <section className="shared-rice-bin-board shared-rice-bin-board-full">
          <div className="shared-rice-bin-board-heading">
            <div>
              <h3>읽기 전용</h3>
              <p>현재 화면에서 공유 쌀통을 읽기 전용으로 보고 있습니다.</p>
            </div>
            <div className="shared-rice-bin-actions">
              <button type="button" onClick={handleSharedBoardClose}>
                <Search aria-hidden="true" size={15} />
                조회로 돌아가기
              </button>
              {isAuthenticated ? (
                <>
                  {sharedBoardShareId ? (
                    <button type="button" onClick={() => openSharedRiceBinInNewTab(sharedBoardShareId)}>
                      <ExternalLink aria-hidden="true" size={15} />새 탭
                    </button>
                  ) : null}
                  <button
                    disabled={!sharedBoardShareId || isSharedRiceBinWriteDisabled(writeLocked, pending, `favorite:${sharedBoardShareId}`)}
                    type="button"
                    onClick={() => {
                      if (sharedBoardShareId) void handleFavoriteToggle(sharedBoardShareId).catch(() => undefined);
                    }}
                  >
                    <Heart aria-hidden="true" size={15} />
                    {sharedBoardFavorite ? "즐겨찾기 해제" : "즐겨찾기"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <BoardOverview
            activeSheetId={sharedActiveSheetId}
            board={sharedBoard}
            onSheetSelected={setSharedActiveSheetId}
            readOnly
          />
        </section>
      </section>
    );
  }

  return (
    <section className="shared-rice-bin-panel" aria-label="공유 쌀통">
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="shared-rice-bin-message">{message}</p> : null}
      {writeLocked ? <p role="status">로그아웃 중에는 공유 설정을 변경할 수 없습니다.</p> : null}

      <div className={`shared-rice-bin-hub${isAuthenticated && overview ? "" : " single"}`}>
        <section className="shared-rice-bin-section shared-rice-bin-lookup-panel">
          <div className="shared-rice-bin-section-heading">
            <h3>공유 쌀통 조회</h3>
            <span>아이디 또는 링크</span>
          </div>
          <div className="shared-rice-bin-section-body">
            <form className="shared-rice-bin-lookup" onSubmit={handleLookupSubmit}>
              <label>
                아이디 또는 링크
                <input
                  value={lookupValue}
                  onChange={(event) => setLookupValue(event.currentTarget.value)}
                  placeholder="공유 아이디 또는 링크"
                  maxLength={200}
                />
              </label>
              <button disabled={pending === "lookup"} type="submit">
                <Search aria-hidden="true" size={16} />
                열기
              </button>
              <button disabled={pending === "lookup"} type="button" onClick={() => handleLookupNewTab()}>
                <ExternalLink aria-hidden="true" size={16} />새 탭
              </button>
            </form>

            {isAuthenticated ? (
              <div className="shared-rice-bin-subsection">
                <h4>즐겨찾기</h4>
                {favorites.length === 0 ? <p className="shared-rice-bin-empty">즐겨찾기한 쌀통이 없습니다.</p> : null}
                <div className="shared-rice-bin-list">
                  {favorites.map((favorite) => (
                    <div key={favorite.shareId} className="shared-rice-bin-row">
                      <div>
                        <strong>{favorite.sheetName}</strong>
                        <small>{favorite.ownerDisplayName}</small>
                      </div>
                      <div className="shared-rice-bin-actions">
                        <button type="button" onClick={() => void handleLookup(favorite.shareId)}>
                          <Search aria-hidden="true" size={15} />
                          열기
                        </button>
                        <button type="button" onClick={() => openSharedRiceBinInNewTab(favorite.shareId)}>
                          <ExternalLink aria-hidden="true" size={15} />새 탭
                        </button>
                        <button disabled={isSharedRiceBinWriteDisabled(writeLocked, pending, `favorite:${favorite.shareId}`)} type="button" onClick={() => void handleFavoriteToggle(favorite.shareId).catch(() => undefined)}>
                          <Heart aria-hidden="true" size={15} />
                          해제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {isAuthenticated && overview ? (
          <section className="shared-rice-bin-section shared-rice-bin-share-panel">
            <div className="shared-rice-bin-section-heading">
              <h3>내 쌀통 공유</h3>
            </div>
            <div className="shared-rice-bin-section-body">
              <div className="shared-rice-bin-list">
                {sheets.map((sheet) => {
                  const share = shareBySheetId.get(sheet.id);
                  const link = share ? buildSharedRiceBinLink(share.shareId) : null;
                  return (
                    <div key={sheet.id} className="shared-rice-bin-row">
                      <div>
                        <strong>{sheet.name}</strong>
                        {share ? <small>{share.shareId}</small> : <small>공유 중이 아닙니다.</small>}
                      </div>
                      <div className="shared-rice-bin-actions">
                        {share && link ? (
                          <>
                            <button type="button" onClick={() => void copyText(link)}>
                              <Copy aria-hidden="true" size={15} />
                              복사
                            </button>
                            <button type="button" onClick={() => void handleLookup(share.shareId)}>
                              <Search aria-hidden="true" size={15} />
                              열기
                            </button>
                            <button type="button" onClick={() => openSharedRiceBinInNewTab(share.shareId)}>
                              <ExternalLink aria-hidden="true" size={15} />새 탭
                            </button>
                            <button disabled={isSharedRiceBinWriteDisabled(writeLocked, pending, `share:${sheet.id}`)} type="button" onClick={() => void handleShareStop(sheet.id).catch(() => undefined)}>
                              <Trash2 aria-hidden="true" size={15} />
                              공유 중단
                            </button>
                          </>
                        ) : (
                          <button disabled={isSharedRiceBinWriteDisabled(writeLocked, pending, `share:${sheet.id}`)} type="button" onClick={() => void handleShareStart(sheet.id).catch(() => undefined)}>
                            <Share2 aria-hidden="true" size={15} />
                            공유 시작
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        ) : null}
      </div>

    </section>
  );
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  await navigator.clipboard.writeText(text);
}
