import { Copy, ExternalLink, Heart, Search, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiDelete, apiGet, apiPost } from "../../api/client";
import { BoardOverview } from "../board/BoardOverview";
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

interface Props {
  initialShareId?: string | null | undefined;
  ownerBoard?: BoardPayload | null | undefined;
  resetToLookupKey?: number | undefined;
  onSharedBoardClosed?: (() => void) | undefined;
  onSharedBoardOpened?: ((shareId: string) => void) | undefined;
  onOwnerBoardChanged?: (() => Promise<BoardPayload | null> | void) | undefined;
  sessionStatus: SessionState["status"];
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
  ownerBoard,
  resetToLookupKey = 0,
  onSharedBoardClosed,
  onSharedBoardOpened,
  onOwnerBoardChanged,
  sessionStatus
}: Props) {
  const [lookupValue, setLookupValue] = useState(initialShareId ?? "");
  const [sharedBoard, setSharedBoard] = useState<BoardPayload | null>(null);
  const [shares, setShares] = useState<BoardShareSummary[]>([]);
  const [favorites, setFavorites] = useState<BoardShareFavoriteSummary[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastResetToLookupKeyRef = useRef(resetToLookupKey);
  const isAuthenticated = sessionStatus === "authenticated";
  const shareBySheetId = useMemo(() => new Map(shares.map((share) => [share.sheetId, share])), [shares]);
  const favoriteShareIds = useMemo(() => new Set(favorites.map((favorite) => favorite.shareId)), [favorites]);

  async function refreshShares() {
    if (!isAuthenticated) return;
    const [sharePayload, favoritePayload] = await Promise.all([
      apiGet<{ shares: BoardShareSummary[] }>("/api/board/shares"),
      apiGet<{ favorites: BoardShareFavoriteSummary[] }>("/api/board/share-favorites")
    ]);
    setShares(sharePayload.shares);
    setFavorites(favoritePayload.favorites);
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setShares([]);
      setFavorites([]);
      return;
    }
    let active = true;
    refreshShares().catch((err) => {
      if (active) setError(err instanceof Error ? err.message : "공유 쌀통 목록을 불러오지 못했습니다.");
    });
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!initialShareId) {
      setSharedBoard(null);
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
    try {
      const payload = await apiGet<BoardPayload>("/api/shared-rice-bins/" + encodeURIComponent(shareId));
      setSharedBoard({ ...payload, readOnly: true });
      setLookupValue(shareId);
      if (options.syncHistory ?? true) onSharedBoardOpened?.(shareId);
    } catch (err) {
      setSharedBoard(null);
      setError(err instanceof Error ? err.message : "공유 쌀통을 불러오지 못했습니다.");
    } finally {
      setPending(null);
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
    setPending(`share:${sheetId}`);
    setError(null);
    try {
      const created = await apiPost<{ shareId: string }>("/api/board/sheets/" + encodeURIComponent(sheetId) + "/share", {});
      await refreshShares();
      await onOwnerBoardChanged?.();
      setMessage("공유 아이디를 새로 만들었습니다.");
      await copyText(buildSharedRiceBinLink(created.shareId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "공유를 시작하지 못했습니다.");
    } finally {
      setPending(null);
    }
  }

  async function handleShareStop(sheetId: string) {
    setPending(`share:${sheetId}`);
    setError(null);
    try {
      await apiDelete("/api/board/sheets/" + encodeURIComponent(sheetId) + "/share");
      await refreshShares();
      await onOwnerBoardChanged?.();
      setMessage("공유를 중단했습니다. 기존 링크는 더 이상 열리지 않습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "공유를 중단하지 못했습니다.");
    } finally {
      setPending(null);
    }
  }

  async function handleFavoriteToggle(shareId: string) {
    if (!isAuthenticated) return;
    setPending(`favorite:${shareId}`);
    setError(null);
    try {
      if (favoriteShareIds.has(shareId)) {
        await apiDelete("/api/board/share-favorites/" + encodeURIComponent(shareId));
      } else {
        await apiPost("/api/board/share-favorites", { shareId });
      }
      await refreshShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "즐겨찾기를 저장하지 못했습니다.");
    } finally {
      setPending(null);
    }
  }

  function handleLookupSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleLookup();
  }

  function handleSharedBoardClose() {
    setSharedBoard(null);
    onSharedBoardClosed?.();
  }

  const sharedBoardShareId = sharedBoard?.shareId ?? null;

  if (sharedBoard) {
    return (
      <section className="shared-rice-bin-panel" aria-label="공유 쌀통">
        {error ? <p className="error-text">{error}</p> : null}
        {message ? <p className="shared-rice-bin-message">{message}</p> : null}

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
                    disabled={!sharedBoardShareId || pending === `favorite:${sharedBoardShareId}`}
                    type="button"
                    onClick={() => sharedBoardShareId && void handleFavoriteToggle(sharedBoardShareId)}
                  >
                    <Heart aria-hidden="true" size={15} />
                    {sharedBoardShareId && favoriteShareIds.has(sharedBoardShareId) ? "즐겨찾기 해제" : "즐겨찾기"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <BoardOverview board={sharedBoard} readOnly />
        </section>
      </section>
    );
  }

  return (
    <section className="shared-rice-bin-panel" aria-label="공유 쌀통">
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="shared-rice-bin-message">{message}</p> : null}

      <div className={`shared-rice-bin-hub${isAuthenticated && ownerBoard ? "" : " single"}`}>
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
                        <button disabled={pending === `favorite:${favorite.shareId}`} type="button" onClick={() => void handleFavoriteToggle(favorite.shareId)}>
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

        {isAuthenticated && ownerBoard ? (
          <section className="shared-rice-bin-section shared-rice-bin-share-panel">
            <div className="shared-rice-bin-section-heading">
              <h3>내 쌀통 공유</h3>
            </div>
            <div className="shared-rice-bin-section-body">
              <div className="shared-rice-bin-list">
                {ownerBoard.sheets.map((sheet) => {
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
                            <button disabled={pending === `share:${sheet.id}`} type="button" onClick={() => void handleShareStop(sheet.id)}>
                              <Trash2 aria-hidden="true" size={15} />
                              공유 중단
                            </button>
                          </>
                        ) : (
                          <button disabled={pending === `share:${sheet.id}`} type="button" onClick={() => void handleShareStart(sheet.id)}>
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
