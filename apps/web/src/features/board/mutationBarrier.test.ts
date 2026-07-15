import { describe, expect, it, vi } from "vitest";
import {
  BoardMutationBarrierLockedError,
  createBoardMutationBarrier
} from "./mutationBarrier";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("BoardMutationBarrier", () => {
  it("locks synchronously, drains already-started work, and refuses new operations", async () => {
    const activeStep = deferred<void>();
    const barrier = createBoardMutationBarrier();
    const activeOperation = barrier.run(async () => {
      await activeStep.promise;
      return "saved";
    });

    const drain = barrier.lockAndDrain();
    const refusedOperation = vi.fn(async () => "late");

    expect(barrier.isLocked()).toBe(true);
    await expect(barrier.run(refusedOperation)).rejects.toBeInstanceOf(BoardMutationBarrierLockedError);
    expect(refusedOperation).not.toHaveBeenCalled();

    activeStep.resolve();
    await expect(activeOperation).resolves.toBe("saved");
    await expect(drain).resolves.toBeUndefined();
  });

  it("waits for the entire registered async chain, including follow-up work", async () => {
    const firstRequest = deferred<void>();
    const followUpRequest = deferred<void>();
    const events: string[] = [];
    const barrier = createBoardMutationBarrier();
    const operation = barrier.run(async () => {
      events.push("first:start");
      await firstRequest.promise;
      events.push("follow-up:start");
      await followUpRequest.promise;
      events.push("complete");
    });
    let drained = false;
    const drain = barrier.lockAndDrain().then(() => {
      drained = true;
    });

    firstRequest.resolve();
    await vi.waitFor(() => expect(events).toEqual(["first:start", "follow-up:start"]));
    expect(drained).toBe(false);

    followUpRequest.resolve();
    await operation;
    await drain;
    expect(events).toEqual(["first:start", "follow-up:start", "complete"]);
  });

  it("contains operation failures while draining and accepts work again after unlock", async () => {
    const barrier = createBoardMutationBarrier();
    const failed = barrier.run(async () => {
      throw new Error("save failed");
    });
    const drain = barrier.lockAndDrain();

    await expect(failed).rejects.toThrow("save failed");
    await expect(drain).resolves.toBeUndefined();

    barrier.unlock();
    await expect(barrier.run(async () => "retried")).resolves.toBe("retried");
  });
});
