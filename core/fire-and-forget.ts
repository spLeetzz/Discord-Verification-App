/**
 * Fire-and-forget.
 *
 * Node 20 terminates the process on an unhandled rejection. Quotient's
 * `create_task` only warned, which is why Quotient could survive a failing
 * background job; this codebase cannot, so every detached promise goes
 * through here.
 *
 * The rule this module enforces: **nothing is ever awaited inside a
 * Discord event handler unless the handler is allowed to block.** A button
 * handler that fires a background job calls `run(...)` and returns.
 */

import { logger } from "../utils/logger.js";

/**
 * Reports a failure.
 *
 * The logger is the default; `onError` replaces it so a test can observe
 * the failure without reaching into the logger.
 */
function report(
  error: unknown,
  label: string,
  onError?: (error: unknown, label: string) => void,
): void {
  if (onError) {
    onError(error, label);
    return;
  }

  logger.error(`[${label}]`, error);
}

/**
 * Runs a function without waiting for it, and swallows any failure.
 *
 * @param fn       the work. May be sync or async.
 * @param label    what the work is, for the log line.
 * @param onError  called instead of the logger when the work fails.
 */
export function run(
  fn: () => Promise<unknown> | unknown,
  label: string,
  onError?: (error: unknown, label: string) => void,
): void {
  let result: Promise<unknown> | unknown;

  try {
    result = fn();
  } catch (error) {
    report(error, label, onError);
    return;
  }

  // `Promise.resolve` also copes with a thenable that is not a `Promise`.
  void Promise.resolve(result).catch((error: unknown) => {
    report(error, label, onError);
  });
}

/**
 * Runs a function and waits for it, but never lets it throw.
 *
 * For the rare case where the caller genuinely needs the work to finish —
 * deleting a message after the invoking message disappears, say — and
 * still does not want a rejection to escape into the event handler.
 */
export async function runAsync(
  fn: () => Promise<unknown> | unknown,
  label: string,
  onError?: (error: unknown, label: string) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    report(error, label, onError);
  }
}
