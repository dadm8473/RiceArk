import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_FETCH_TIMEOUT_MS, fetchExternal } from "./externalFetch";

describe("fetchExternal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("composes the caller signal with an eight-second timeout signal", async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const receivedSignals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      receivedSignals.push(init?.signal as AbortSignal);
      return new Response(null, { status: 204 });
    });

    await fetchExternal("https://example.com", { signal: caller.signal });

    expect(EXTERNAL_FETCH_TIMEOUT_MS).toBe(8_000);
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
    caller.abort();
    expect(receivedSignals[0]?.aborted).toBe(true);
  });

  it("performs exactly one fetch attempt when the timeout aborts", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
    );

    const request = fetchExternal("https://example.com");
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
