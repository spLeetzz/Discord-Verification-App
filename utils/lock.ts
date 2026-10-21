/**
 * A tiny async mutex.
 *
 * Sheet writes for the same event are queued so two staff members hitting
 * /verify and /deny at the same time cannot interleave and leave the sheet
 * and Discord out of sync.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with exclusive access to `key`.
 *
 * Calls run in the order they arrive. A failing call does not break the
 * queue for the ones behind it.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();

  const next = previous.then(fn, fn);

  // Keep the chain alive, but never let it reject.
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
}
