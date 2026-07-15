export interface BoardMutationRunner {
  <T>(operation: () => Promise<T>): Promise<T>;
}

export interface BoardMutationBarrier {
  run: BoardMutationRunner;
  lockAndDrain: () => Promise<void>;
  unlock: () => void;
  isLocked: () => boolean;
}

export class BoardMutationBarrierLockedError extends Error {
  constructor() {
    super("Board mutations are locked while logout is in progress");
    this.name = "BoardMutationBarrierLockedError";
  }
}

export const runBoardMutationDirect: BoardMutationRunner = async (operation) => operation();

export function createBoardMutationBarrier(): BoardMutationBarrier {
  const active = new Set<Promise<void>>();
  let locked = false;

  const run: BoardMutationRunner = <T>(operation: () => Promise<T>) => {
    if (locked) {
      const refusal = Promise.reject<T>(new BoardMutationBarrierLockedError());
      void refusal.catch(() => undefined);
      return refusal;
    }

    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    active.add(completion);

    let result: Promise<T>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      () => {
        active.delete(completion);
        finish();
      },
      () => {
        active.delete(completion);
        finish();
      }
    );
    return result;
  };

  return {
    run,
    lockAndDrain: async () => {
      locked = true;
      await Promise.allSettled([...active]);
    },
    unlock: () => {
      locked = false;
    },
    isLocked: () => locked
  };
}
