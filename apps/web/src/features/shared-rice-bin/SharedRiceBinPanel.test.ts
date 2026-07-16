import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/client";
import {
  buildSharedRiceBinLink,
  extractSharedRiceBinId,
  isSharedRiceBinWriteDisabled,
  openSharedRiceBinInNewTab,
  runSharedRiceBinWrite,
  SharedRiceBinPanel
} from "./SharedRiceBinPanel";
import { createBoardMutationBarrier } from "../board/mutationBarrier";
import type { BoardPayload } from "../board/types";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<{
    callback: () => void | (() => void);
    cleanup: (() => void) | undefined;
    dependencies: readonly unknown[] | undefined;
    pending: boolean;
  }>,
  effectCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  stateCursor: 0,
  stateValues: [] as unknown[],
  stateUpdates: [] as unknown[]
}));

const api = vi.hoisted(() => ({
  calls: [] as string[],
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn()
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = hooks.effectCursor++;
      const previous = hooks.effects[index];
      const pending =
        !previous ||
        dependencies === undefined ||
        previous.dependencies === undefined ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies?.[dependencyIndex]));
      hooks.effects[index] = {
        callback,
        cleanup: previous?.cleanup,
        dependencies,
        pending
      };
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => {
      const index = hooks.refCursor++;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initial };
      return hooks.refs[index] as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.stateCursor++;
      if (!Object.prototype.hasOwnProperty.call(hooks.stateValues, index)) {
        hooks.stateValues[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [hooks.stateValues[index] as T, (next: T | ((current: T) => T)) => {
        hooks.stateUpdates.push(next);
        hooks.stateValues[index] =
          typeof next === "function"
            ? (next as (current: T) => T)(hooks.stateValues[index] as T)
            : next;
      }] as const;
    }
  };
});

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    apiDelete: api.apiDelete,
    apiGet: api.apiGet,
    apiPost: api.apiPost
  };
});

const shareId = "AbCdEfGhIjKlMnOpQrStUv";
const replacementShareId = "ZyXwVuTsRqPoNmLkJiHgFe";

const ownerBoard: BoardPayload = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1 }],
  tables: [],
  notes: [],
  axisItems: [],
  cellStates: [],
  completions: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function flushPromises() {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
}

function runCapturedEffects() {
  for (const effect of hooks.effects) {
    if (!effect.pending) continue;
    effect.cleanup?.();
    const cleanup = effect.callback();
    effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    effect.pending = false;
  }
}

function renderPanel(
  props: Parameters<typeof SharedRiceBinPanel>[0]
): ReactElement {
  hooks.effectCursor = 0;
  hooks.refCursor = 0;
  hooks.stateCursor = 0;
  return SharedRiceBinPanel(props);
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement(node)) {
    return Children.toArray(node).map((child) => getNodeText(child)).join("");
  }
  return getNodeText((node.props as { children?: ReactNode }).children ?? null);
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean
): ReactElement | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (!isValidElement(node)) {
    for (const child of Children.toArray(node)) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

function findButton(
  root: ReactElement,
  label: string,
  rowText?: string
): ReactElement<{ onClick: () => void }> {
  const scope = rowText
    ? findElement(root, (element) => {
        const props = element.props as { className?: string };
        return props.className === "shared-rice-bin-row" && getNodeText(element).includes(rowText);
      })
    : root;
  expect(scope).not.toBeNull();
  const button = findElement(scope, (element) =>
    element.type === "button" && getNodeText(element).trim() === label
  );
  expect(button).not.toBeNull();
  return button as ReactElement<{ onClick: () => void }>;
}

function createSharedBoardPayload(
  id = shareId,
  version = 7
): BoardPayload & { shareId: string; readOnly: true; version: number } {
  return {
    ...ownerBoard,
    shareId: id,
    readOnly: true,
    version
  };
}

function installFakeBrowser(initialVisibility: DocumentVisibilityState = "visible") {
  let visibilityState = initialVisibility;
  const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const documentListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  function addListener(
    target: Map<string, Set<EventListenerOrEventListenerObject>>,
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    const listeners = target.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    target.set(type, listeners);
  }

  function removeListener(
    target: Map<string, Set<EventListenerOrEventListenerObject>>,
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    target.get(type)?.delete(listener);
  }

  function dispatch(target: Map<string, Set<EventListenerOrEventListenerObject>>, type: string) {
    for (const listener of target.get(type) ?? []) {
      if (typeof listener === "function") listener({ type } as Event);
      else listener.handleEvent({ type } as Event);
    }
  }

  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      addListener(windowListeners, type, listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      removeListener(windowListeners, type, listener);
    },
    location: { origin: "https://riceark.pages.dev" }
  });
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      addListener(documentListeners, type, listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      removeListener(documentListeners, type, listener);
    },
    get visibilityState() {
      return visibilityState;
    }
  });

  return {
    dispatchFocus: () => dispatch(windowListeners, "focus"),
    dispatchVisibilityChange: () => dispatch(documentListeners, "visibilitychange")
  };
}

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.effectCursor = 0;
  hooks.refs.length = 0;
  hooks.refCursor = 0;
  hooks.stateCursor = 0;
  hooks.stateValues.length = 0;
  hooks.stateUpdates.length = 0;
  api.calls.length = 0;
  api.apiDelete.mockReset();
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiGet.mockImplementation(async (path: string) => {
    api.calls.push(path);
    if (path === "/api/board/sharing-overview") {
      return { sheets: ownerBoard.sheets, shares: [], favorites: [] };
    }
    if (path === `/api/shared-rice-bins/${shareId}`) {
      return createSharedBoardPayload();
    }
    if (path === `/api/shared-rice-bins/${shareId}/version`) {
      return { version: 7 };
    }
    if (path === `/api/board/share-favorites/${shareId}`) {
      return { favorite: true };
    }
    return {};
  });
  api.apiPost.mockImplementation(async (path: string) => {
    api.calls.push(path);
    return { shareId };
  });
  api.apiDelete.mockImplementation(async (path: string) => {
    api.calls.push(path);
    return undefined;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractSharedRiceBinId", () => {
  it("accepts raw ids and RiceArk share links", () => {
    expect(extractSharedRiceBinId(shareId)).toBe(shareId);
    expect(extractSharedRiceBinId(`https://riceark.pages.dev/?share=${shareId}`)).toBe(shareId);
    expect(extractSharedRiceBinId(`https://riceark.pages.dev/shared/${shareId}`)).toBe(shareId);
    expect(extractSharedRiceBinId("짧은값")).toBeNull();
  });
});

describe("shared rice bin links", () => {
  it("builds share links from a supplied origin", () => {
    expect(buildSharedRiceBinLink(shareId, "https://riceark.pages.dev")).toBe(`https://riceark.pages.dev/?share=${shareId}`);
  });

  it("opens shared rice bins in a new browser tab", () => {
    const open = vi.fn(() => ({ opener: {} }));

    expect(openSharedRiceBinInNewTab(shareId, { open, origin: "https://riceark.pages.dev" })).toBe(true);
    expect(open).toHaveBeenCalledWith(`https://riceark.pages.dev/?share=${shareId}`, "_blank", "noopener,noreferrer");
  });
});

describe("SharedRiceBinPanel", () => {
  it("loads direct public detail before authenticated favorite status and skips owner overview requests", async () => {
    const detail = deferred<BoardPayload & { shareId: string }>();
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === `/api/shared-rice-bins/${shareId}`) return detail.promise;
      if (path === `/api/board/share-favorites/${shareId}`) return { favorite: true };
      return {};
    });

    renderToStaticMarkup(
      createElement(SharedRiceBinPanel, {
        initialShareId: shareId,
        sessionStatus: "authenticated"
      })
    );
    runCapturedEffects();

    expect(api.calls).toEqual([`/api/shared-rice-bins/${shareId}`]);
    expect(api.calls).not.toContain("/api/board/bootstrap");
    expect(api.calls).not.toContain("/api/board/sharing-overview");
    expect(api.calls).not.toContain("/api/board/shares");
    expect(api.calls).not.toContain("/api/board/share-favorites");

    detail.resolve(createSharedBoardPayload());
    await flushPromises();

    expect(api.calls).toEqual([
      `/api/shared-rice-bins/${shareId}`,
      `/api/board/share-favorites/${shareId}`
    ]);
    expect(hooks.stateUpdates).toContainEqual(expect.objectContaining({ shareId, readOnly: true }));
  });

  it("loads anonymous direct public detail without favorite, owner, or overview requests", async () => {
    renderToStaticMarkup(
      createElement(SharedRiceBinPanel, {
        initialShareId: shareId,
        sessionStatus: "anonymous"
      })
    );
    runCapturedEffects();
    await flushPromises();

    expect(api.calls).toEqual([`/api/shared-rice-bins/${shareId}`]);
    expect(api.calls).not.toContain("/api/board/bootstrap");
    expect(api.calls).not.toContain("/api/board/sharing-overview");
    expect(api.calls).not.toContain(`/api/board/share-favorites/${shareId}`);
  });

  it("loads exactly one authenticated sharing overview for the hub", async () => {
    renderToStaticMarkup(createElement(SharedRiceBinPanel, { sessionStatus: "authenticated" }));
    runCapturedEffects();
    await flushPromises();

    expect(api.calls).toEqual(["/api/board/sharing-overview"]);
    expect(api.calls).not.toContain("/api/board/bootstrap");
    expect(api.calls).not.toContain("/api/board/shares");
    expect(api.calls).not.toContain("/api/board/share-favorites");
  });

  it("uses loaded overview favorite state when opening detail without a favorite status request", async () => {
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === "/api/board/sharing-overview") {
        return {
          sheets: [{ ...ownerBoard.sheets[0]!, version: 7 }],
          shares: [],
          favorites: [{
            shareId,
            sheetId: "sheet-1",
            sheetName: "친구 보드",
            ownerDisplayName: "친구",
            createdAt: "2026-07-16T00:00:00.000Z"
          }]
        };
      }
      if (path === `/api/shared-rice-bins/${shareId}`) return createSharedBoardPayload();
      if (path === `/api/board/share-favorites/${shareId}`) return { favorite: false };
      return {};
    });

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    const hub = renderPanel({ sessionStatus: "authenticated" });
    findButton(hub, "열기", "친구 보드").props.onClick();
    await flushPromises();

    const detail = renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    expect(api.calls).toEqual([
      "/api/board/sharing-overview",
      `/api/shared-rice-bins/${shareId}`
    ]);
    expect(api.calls).not.toContain(`/api/board/share-favorites/${shareId}`);
    expect(getNodeText(detail)).toContain("즐겨찾기 해제");
  });

  it("checks a visible shared board version on focus without reloading unchanged detail", async () => {
    const browser = installFakeBrowser();

    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();
    await flushPromises();

    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();
    browser.dispatchFocus();
    await flushPromises();

    expect(api.calls).toEqual([
      `/api/shared-rice-bins/${shareId}`,
      `/api/shared-rice-bins/${shareId}/version`
    ]);
  });

  it("deduplicates visible focus events and reloads changed shared detail exactly once", async () => {
    const browser = installFakeBrowser();
    const versionRequest = deferred<{ version: number }>();
    let detailReads = 0;
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === `/api/shared-rice-bins/${shareId}`) {
        detailReads += 1;
        return createSharedBoardPayload(shareId, detailReads === 1 ? 7 : 8);
      }
      if (path === `/api/shared-rice-bins/${shareId}/version`) return versionRequest.promise;
      return {};
    });

    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();
    await flushPromises();
    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();

    browser.dispatchVisibilityChange();
    browser.dispatchFocus();
    expect(api.calls.filter((path) => path.endsWith("/version"))).toHaveLength(1);

    versionRequest.resolve({ version: 8 });
    await flushPromises();

    expect(api.calls.filter((path) => path === `/api/shared-rice-bins/${shareId}`)).toHaveLength(2);
    expect(hooks.stateUpdates).toContainEqual(expect.objectContaining({ shareId, version: 8, readOnly: true }));
  });

  it("clears a shared board and shows a revoked lookup error when focus revalidation returns 404", async () => {
    const browser = installFakeBrowser();
    const onSharedBoardClosed = vi.fn();
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === `/api/shared-rice-bins/${shareId}`) return createSharedBoardPayload();
      if (path === `/api/shared-rice-bins/${shareId}/version`) {
        throw new ApiClientError(404, "not_found", "Shared board not found");
      }
      return {};
    });

    renderPanel({ initialShareId: shareId, onSharedBoardClosed, sessionStatus: "anonymous" });
    runCapturedEffects();
    await flushPromises();
    renderPanel({ initialShareId: shareId, onSharedBoardClosed, sessionStatus: "anonymous" });
    runCapturedEffects();

    browser.dispatchFocus();
    await flushPromises();

    const lookup = renderPanel({ initialShareId: null, onSharedBoardClosed, sessionStatus: "anonymous" });
    runCapturedEffects();
    expect(getNodeText(lookup)).toContain("공유가 중단되었거나 삭제된 쌀통입니다.");
    expect(getNodeText(lookup)).not.toContain("읽기 전용");
    expect(onSharedBoardClosed).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate a shared board while the document is hidden", async () => {
    const browser = installFakeBrowser("hidden");

    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();
    await flushPromises();
    renderPanel({ initialShareId: shareId, sessionStatus: "anonymous" });
    runCapturedEffects();

    browser.dispatchVisibilityChange();
    browser.dispatchFocus();
    await flushPromises();

    expect(api.calls).toEqual([`/api/shared-rice-bins/${shareId}`]);
  });

  it("refreshes the authenticated sharing overview once on visible hub focus", async () => {
    const browser = installFakeBrowser();

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    browser.dispatchFocus();
    await flushPromises();

    expect(api.calls).toEqual([
      "/api/board/sharing-overview",
      "/api/board/sharing-overview"
    ]);
  });

  it("refreshes the in-memory overview when returning from detail to the hub", async () => {
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === "/api/board/sharing-overview") {
        return {
          sheets: [{ ...ownerBoard.sheets[0]!, version: 7 }],
          shares: [],
          favorites: [{
            shareId,
            sheetId: "sheet-1",
            sheetName: "친구 보드",
            ownerDisplayName: "친구",
            createdAt: "2026-07-16T00:00:00.000Z"
          }]
        };
      }
      if (path === `/api/shared-rice-bins/${shareId}`) return createSharedBoardPayload();
      return {};
    });

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();
    const hub = renderPanel({ sessionStatus: "authenticated" });
    findButton(hub, "열기", "친구 보드").props.onClick();
    await flushPromises();

    const detail = renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    findButton(detail, "조회로 돌아가기").props.onClick();

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    expect(api.calls.filter((path) => path === "/api/board/sharing-overview")).toHaveLength(2);
  });

  it("does not create a polling interval for shared state revalidation", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("setInterval(");
  });

  it("renders anonymous lookup hub without any overview request", async () => {
    renderToStaticMarkup(createElement(SharedRiceBinPanel, { sessionStatus: "anonymous" }));
    runCapturedEffects();
    await flushPromises();

    expect(api.calls).toEqual([]);
  });

  it("uses lightweight overview data and local mutation updates instead of owner board props or blanket refreshes", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf8");

    expect(source).toContain("/api/board/sharing-overview");
    expect(source).not.toContain("ownerBoard");
    expect(source).not.toContain("onOwnerBoardChanged");
    expect(source).not.toContain("/api/board/shares");
    expect(source).not.toMatch(/apiGet<\{\s*favorites:/);
    expect(source).not.toContain("refreshShares");
  });

  it("stops a share by removing both the share and its matching favorite locally", async () => {
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === "/api/board/sharing-overview") {
        return {
          sheets: [{ ...ownerBoard.sheets[0]!, version: 7 }],
          shares: [{
            shareId,
            sheetId: "sheet-1",
            sheetName: "숙제",
            createdAt: "2026-07-16T00:00:00.000Z"
          }],
          favorites: [{
            shareId,
            sheetId: "sheet-1",
            sheetName: "중단될 즐겨찾기",
            ownerDisplayName: "나",
            createdAt: "2026-07-16T00:00:00.000Z"
          }]
        };
      }
      return {};
    });

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    const hub = renderPanel({ sessionStatus: "authenticated" });
    findButton(hub, "공유 중단", shareId).props.onClick();
    await flushPromises();

    const updatedHub = renderPanel({ sessionStatus: "authenticated" });
    const updatedText = getNodeText(updatedHub);
    expect(api.calls).toEqual([
      "/api/board/sharing-overview",
      "/api/board/sheets/sheet-1/share"
    ]);
    expect(api.apiDelete).toHaveBeenCalledWith("/api/board/sheets/sheet-1/share");
    expect(updatedText).toContain("공유 중이 아닙니다.");
    expect(updatedText).toContain("즐겨찾기한 쌀통이 없습니다.");
    expect(updatedText).not.toContain("중단될 즐겨찾기");
  });

  it("starts a replacement share by removing the previous favorite and inserting the returned share locally", async () => {
    api.apiGet.mockImplementation(async (path: string) => {
      api.calls.push(path);
      if (path === "/api/board/sharing-overview") {
        return {
          sheets: [{ ...ownerBoard.sheets[0]!, version: 7 }],
          shares: [],
          favorites: [{
            shareId,
            sheetId: "sheet-1",
            sheetName: "이전 공유 즐겨찾기",
            ownerDisplayName: "나",
            createdAt: "2026-07-16T00:00:00.000Z"
          }]
        };
      }
      return {};
    });
    api.apiPost.mockImplementation(async (path: string) => {
      api.calls.push(path);
      return { shareId: replacementShareId };
    });

    renderPanel({ sessionStatus: "authenticated" });
    runCapturedEffects();
    await flushPromises();

    const hub = renderPanel({ sessionStatus: "authenticated" });
    findButton(hub, "공유 시작", "숙제").props.onClick();
    await flushPromises();

    const updatedHub = renderPanel({ sessionStatus: "authenticated" });
    const updatedText = getNodeText(updatedHub);
    expect(api.calls).toEqual([
      "/api/board/sharing-overview",
      "/api/board/sheets/sheet-1/share"
    ]);
    expect(api.apiPost).toHaveBeenCalledWith("/api/board/sheets/sheet-1/share", {});
    expect(updatedText).toContain(replacementShareId);
    expect(updatedText).toContain("공유 중단");
    expect(updatedText).toContain("즐겨찾기한 쌀통이 없습니다.");
    expect(updatedText).not.toContain("이전 공유 즐겨찾기");
  });

  it("owns controlled active-sheet state for shared read-only boards", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf8");

    expect(source).toContain("sharedActiveSheetId");
    expect(source).toMatch(/<BoardOverview[\s\S]*activeSheetId=\{sharedActiveSheetId\}[\s\S]*onSheetSelected=\{setSharedActiveSheetId\}[\s\S]*readOnly/);
  });

  it.each([
    ["share:sheet-1", null],
    [`favorite:${shareId}`, null],
    ["share:sheet-1", "share:sheet-1"]
  ])("disables the %s write control for lock or matching pending state", (controlKey, pending) => {
    expect(isSharedRiceBinWriteDisabled(true, pending, controlKey)).toBe(true);
    expect(isSharedRiceBinWriteDisabled(false, pending, controlKey)).toBe(pending === controlKey);
  });

  it("keeps a shared write's refresh chain inside one barrier admission", async () => {
    const mutationRequest = deferred<void>();
    const events: string[] = [];
    const barrier = createBoardMutationBarrier();
    const write = runSharedRiceBinWrite(
      barrier.run,
      async () => {
        events.push("mutation:start");
        await mutationRequest.promise;
        events.push("refresh");
      },
      vi.fn(),
      () => events.push("settled")
    );
    const drain = barrier.lockAndDrain();

    mutationRequest.resolve();
    await write;
    await drain;
    expect(events).toEqual(["mutation:start", "refresh", "settled"]);
  });

  it("rethrows shared write failures after UI error and pending cleanup", async () => {
    const failure = new Error("favorite failed");
    const onError = vi.fn();
    const onSettled = vi.fn();
    const barrier = createBoardMutationBarrier();

    const write = runSharedRiceBinWrite(
      barrier.run,
      async () => {
        throw failure;
      },
      onError,
      onSettled
    );
    const drain = barrier.lockAndDrain();

    await expect(write).rejects.toBe(failure);
    await expect(drain).rejects.toMatchObject({ errors: [failure] });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps overview share writes wired to the logout reconciliation lock", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      createElement(SharedRiceBinPanel, {
        sessionStatus: "authenticated",
        writeLocked: true
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("로그아웃 중에는 공유 설정을 변경할 수 없습니다.");
    expect(source).toContain("isSharedRiceBinWriteDisabled(writeLocked, pending, `share:${sheet.id}`)");
    expect(source).toContain("handleShareStart(sheet.id)");
    expect(source).toContain("handleShareStop(sheet.id)");
  });

  it("renders lookup controls for anonymous visitors", () => {
    const html = renderToStaticMarkup(createElement(SharedRiceBinPanel, { sessionStatus: "anonymous" }));

    expect(html).not.toContain('class="shared-rice-bin-header"');
    expect(html).not.toContain("공유 받은 쌀통은 읽기 전용으로만 조회됩니다.");
    expect(html).toContain('class="shared-rice-bin-hub');
    expect(html).toContain("shared-rice-bin-lookup-panel");
    expect(html).not.toContain('class="shared-rice-bin-view-placeholder"');
    expect(html).not.toContain("조회 중인 쌀통");
    expect(html).not.toContain("열기를 누르면 이 영역에 공유 보드가 표시됩니다.");
    expect(html).toContain("공유 쌀통 조회");
    expect(html).toContain("아이디 또는 링크");
    expect(html).toContain("열기");
    expect(html).toContain("새 탭");
    expect(html).not.toContain("새 탭에서 열기");
    expect(html).not.toContain("내 쌀통 공유");
  });

  it("renders owner share management from the authenticated sharing overview", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf-8");

    expect(source).toContain("isAuthenticated && overview");
    expect(source).toContain("내 쌀통 공유");
    expect(source).toContain("shared-rice-bin-share-panel");
    expect(source).toContain("sheets.map((sheet)");
    expect(source).toContain("공유 시작");
    expect(source).not.toContain("공유 시작 시 새 ID");
    expect(source).toContain("즐겨찾기");
    expect(source).toContain("즐겨찾기한 쌀통이 없습니다.");
    expect(source).not.toContain("즐겨찾기한 공유 쌀통이 없습니다.");
  });

  it("uses a board-only layout once a shared rice bin is open", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf-8");

    expect(source).toContain("if (sharedBoard)");
    expect(source.indexOf("if (sharedBoard)")).toBeLessThan(source.indexOf('className={`shared-rice-bin-hub'));
    expect(source).toContain('className="shared-rice-bin-board shared-rice-bin-board-full"');
    expect(source).toContain("<h3>읽기 전용</h3>");
    expect(source).toContain("onSharedBoardClosed?.()");
    expect(source).not.toContain("공유 쌀통 읽기 전용");
  });

  it("can reset an open shared board back to lookup from the parent tab", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf-8");

    expect(source).toContain("resetToLookupKey");
    expect(source).toContain("lastResetToLookupKeyRef");
    expect(source).toMatch(/resetToLookupKey[\s\S]{0,500}setSharedBoard\(null\)[\s\S]{0,260}onSharedBoardClosed\?\.\(\)/);
  });
});
