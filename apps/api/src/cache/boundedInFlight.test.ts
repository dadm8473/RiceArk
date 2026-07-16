import { afterEach, describe, expect, it, vi } from "vitest";
import { withBoundedInFlight } from "./boundedInFlight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("withBoundedInFlight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares the same stored promise for the same key", async () => {
    const inFlight = new Map<string, Promise<string>>();
    const pending = deferred<string>();
    const loader = vi.fn(() => pending.promise);

    const first = withBoundedInFlight(inFlight, "shared-key", loader);
    const second = withBoundedInFlight(inFlight, "shared-key", loader);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(inFlight.get("shared-key")).toBe(first);

    pending.resolve("ok");

    await expect(first).resolves.toBe("ok");
    expect(inFlight.has("shared-key")).toBe(false);
  });

  it("cleans up after a rejected loader", async () => {
    const inFlight = new Map<string, Promise<string>>();
    const error = new Error("boom");

    const promise = withBoundedInFlight(inFlight, "reject-key", async () => {
      throw error;
    });

    await expect(promise).rejects.toThrow("boom");
    expect(inFlight.has("reject-key")).toBe(false);
  });

  it("cleans up after an aborted loader rejection", async () => {
    const inFlight = new Map<string, Promise<string>>();
    const error = new DOMException("Aborted", "AbortError");

    const promise = withBoundedInFlight(inFlight, "abort-key", async () => {
      throw error;
    });

    await expect(promise).rejects.toThrow(/Aborted/);
    expect(inFlight.has("abort-key")).toBe(false);
  });

  it("does not delete a replacement promise during finally cleanup", async () => {
    const inFlight = new Map<string, Promise<string>>();
    const pending = deferred<string>();
    const replacement = Promise.resolve("replacement");

    const promise = withBoundedInFlight(inFlight, "replace-key", () => pending.promise);

    inFlight.set("replace-key", replacement);
    pending.resolve("first");

    await expect(promise).resolves.toBe("first");
    expect(inFlight.get("replace-key")).toBe(replacement);
  });

  it("does not retain a 51st distinct key", async () => {
    const inFlight = new Map<string, Promise<string>>();

    for (let index = 0; index < 50; index += 1) {
      inFlight.set(`key-${index}`, new Promise<string>(() => {}));
    }

    const loader = vi.fn(async () => "overflow");

    await expect(withBoundedInFlight(inFlight, "key-50", loader)).resolves.toBe("overflow");
    await expect(withBoundedInFlight(inFlight, "key-50", loader)).resolves.toBe("overflow");

    expect(loader).toHaveBeenCalledTimes(2);
    expect(inFlight.size).toBe(50);
    expect(inFlight.has("key-50")).toBe(false);
  });

  it("does not create an unhandled rejection from cleanup plumbing", async () => {
    const inFlight = new Map<string, Promise<string>>();
    const events: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      events.push(reason);
    };

    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const promise = withBoundedInFlight(inFlight, "handled-rejection", async () => {
        throw new Error("expected rejection");
      });

      await expect(promise).rejects.toThrow("expected rejection");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
