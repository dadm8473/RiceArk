const MAX_RETAINED_IN_FLIGHT = 50;

export function withBoundedInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  let pending: Promise<T>;
  try {
    pending = loader();
  } catch (error) {
    pending = Promise.reject(error);
  }

  if (inFlight.size >= MAX_RETAINED_IN_FLIGHT) return pending;

  const tracked = pending.finally(() => {
    if (inFlight.get(key) === tracked) {
      inFlight.delete(key);
    }
  });

  inFlight.set(key, tracked);
  return tracked;
}
