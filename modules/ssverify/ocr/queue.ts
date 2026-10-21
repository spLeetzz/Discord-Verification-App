/**
 * A per-instance serial queue.
 *
 * Quotient held one global lock around its OCR call so two submissions could
 * not hit the service at the same time. The lock belongs to the provider
 * rather than to the bot, so a second provider — or a second bot process —
 * is not slowed down by the first one.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `task` once every previously queued task has settled.
   *
   * A failing task does not break the queue for the ones behind it.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);

    // Keep the chain alive, but never let it reject.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
