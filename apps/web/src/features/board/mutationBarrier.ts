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

export class BoardMutationDrainError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "One or more active board mutations failed while preparing to log out");
    this.name = "BoardMutationDrainError";
  }
}

export const runBoardMutationDirect: BoardMutationRunner = async (operation) => operation();

export function createBoardMutationBarrier(): BoardMutationBarrier {
  type OperationOutcome =
    | { status: "fulfilled" }
    | { status: "rejected"; reason: unknown };

  const active = new Set<Promise<OperationOutcome>>();
  let locked = false;

  const run: BoardMutationRunner = <T>(operation: () => Promise<T>) => {
    if (locked) {
      const refusal = Promise.reject<T>(new BoardMutationBarrierLockedError());
      void refusal.catch(() => undefined);
      return refusal;
    }

    let finish!: (outcome: OperationOutcome) => void;
    const completion = new Promise<OperationOutcome>((resolve) => {
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
        finish({ status: "fulfilled" });
      },
      (reason) => {
        active.delete(completion);
        finish({ status: "rejected", reason });
      }
    );
    return result;
  };

  return {
    run,
    lockAndDrain: async () => {
      locked = true;
      const outcomes = await Promise.all([...active]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length > 0) throw new BoardMutationDrainError(failures);
    },
    unlock: () => {
      locked = false;
    },
    isLocked: () => locked
  };
}
