/**
 * Custom id scheme and the ephemeral-state token store.
 *
 * A custom id is `<type>:<action>[:<payload>]` — for example
 * `scrims:editor:set_role:42` or `premium:buy`.
 *
 * The first segment is the *owner*: it names the module that handles the
 * interaction. The router dispatches on that segment and never guesses an
 * owner from the shape of the rest of the id (D7).
 *
 * Two kinds of state travel in a custom id (D18):
 *
 *  - a record id, which is stateless and survives a restart;
 *  - a token, which points into an in-memory map for state that has no
 *    database row yet (a wizard mid-flight, a select menu whose options
 *    are expensive to rebuild).
 *
 * A token is only meaningful to the process that issued it. It is never
 * used for something that a database row could hold.
 */

import { randomBytes } from "node:crypto";

/** The separator between custom id segments. */
export const CUSTOM_ID_SEPARATOR = ":";

/** A custom id split into its parts. */
export interface ParsedCustomId {
  /** The owning module, e.g. `scrims`. */
  readonly type: string;
  /** What the owner should do, e.g. `editor`. */
  readonly action: string;
  /** Everything after the action, or `null` when there is none. */
  readonly payload: string | null;
}

/**
 * Builds a custom id.
 *
 * @throws TypeError when the type or action is empty or contains the
 *         separator — either would make the id unroutable.
 */
export function makeCustomId(
  type: string,
  action: string,
  payload?: string | null,
): string {
  if (!type) {
    throw new TypeError("custom id type must not be empty");
  }

  if (!action) {
    throw new TypeError("custom id action must not be empty");
  }

  if (type.includes(CUSTOM_ID_SEPARATOR)) {
    throw new TypeError(
      `custom id type "${type}" must not contain "${CUSTOM_ID_SEPARATOR}"`,
    );
  }

  if (action.includes(CUSTOM_ID_SEPARATOR)) {
    throw new TypeError(
      `custom id action "${action}" must not contain "${CUSTOM_ID_SEPARATOR}"`,
    );
  }

  const head = `${type}${CUSTOM_ID_SEPARATOR}${action}`;

  if (payload === undefined || payload === null || payload === "") return head;

  return `${head}${CUSTOM_ID_SEPARATOR}${payload}`;
}

/**
 * Splits a custom id back into its parts.
 *
 * @returns `null` when the id does not follow the scheme. The legacy
 *          `verify_btn:<eventKey>` id does follow it: its type is
 *          `verify_btn` and its action is the event key.
 */
export function parseCustomId(id: string): ParsedCustomId | null {
  if (!id) return null;

  const parts = id.split(CUSTOM_ID_SEPARATOR);

  const type = parts[0];
  const action = parts[1];

  if (!type || !action) return null;

  const rest = parts.slice(2).join(CUSTOM_ID_SEPARATOR);

  return {
    type,
    action,
    payload: rest === "" ? null : rest,
  };
}

/**
 * A random, URL-safe id.
 *
 * Used for the tokens that stand in for ephemeral state. 12 bytes is 96
 * bits of entropy, which is plenty for a value that lives for minutes.
 */
export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * The prefix every component that a *pending collector* owns starts with.
 *
 * A collector is a select menu waiting for somebody to pick a channel, a
 * prompt waiting for a confirmation. The interaction that answers it
 * belongs to the collector, not to a module: the collector is the only
 * thing that knows what the answer means.
 *
 * **Why the prefix matters.** The router dispatches every button, select
 * and modal by custom id, and it refuses any id nobody owns — it replies
 * "This button is no longer active". A collector's id is owned by nobody,
 * because no module registered it, so without this prefix the router would
 * refuse the interaction out from under the collector: the reply would
 * acknowledge it, the collector's own `update` would then fail, and the
 * user would be told a button had expired when all they had done was pick
 * a channel.
 *
 * So every collector-owned id carries this prefix, and the router leaves
 * those interactions alone.
 */
export const COLLECTOR_CUSTOM_ID_PREFIX = "core:collect";

/**
 * Builds a custom id for a component a collector will own.
 *
 * @param kind what the collector is waiting for — `select`, `channel`,
 *        `role`, `prompt`. It is only there to keep the ids readable in
 *        the Discord UI; nothing dispatches on it.
 */
export function collectorCustomId(kind: string): string {
  return `${COLLECTOR_CUSTOM_ID_PREFIX}:${kind}:${randomId()}`;
}

/** How a token store is configured. */
export interface TokenStoreOptions {
  /** How long an entry stays valid. Defaults to 15 minutes. */
  ttlMs?: number;
  /** How often expired entries are swept. Defaults to 60 seconds. */
  sweepIntervalMs?: number;
  /** Clock, injectable so tests do not have to sleep. */
  now?: () => number;
}

interface TokenEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * An in-memory map with a time-to-live and a periodic sweep.
 *
 * This is the store behind the token half of D18: a custom id carries a
 * token, the token points at a value here, and the value disappears when
 * nobody uses it in time.
 *
 * The sweep interval is `unref`ed, so a store never keeps the process
 * alive on its own.
 */
export class TokenStore<T> {
  private readonly entries = new Map<string, TokenEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout | null;

  constructor(options: TokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;

    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

    this.timer = setInterval(() => {
      this.sweep();
    }, sweepIntervalMs);

    // The store is a convenience, not a reason to stay alive.
    this.timer.unref();
  }

  /**
   * Stores a value and returns the token that points at it.
   */
  issue(value: T): string {
    const token = randomId();

    this.entries.set(token, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    return token;
  }

  /**
   * Reads a value without consuming it.
   *
   * An expired entry is dropped and reported as missing.
   */
  get(token: string): T | undefined {
    const entry = this.entries.get(token);

    if (!entry) return undefined;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Reads a value and removes it.
   *
   * Used for one-shot state, where a second click must not repeat the
   * action.
   */
  take(token: string): T | undefined {
    const value = this.get(token);

    this.entries.delete(token);

    return value;
  }

  /**
   * Replaces the value behind a token and refreshes its expiry.
   *
   * @returns whether the token was live.
   */
  set(token: string, value: T): boolean {
    const entry = this.entries.get(token);

    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return false;
    }

    this.entries.set(token, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    return true;
  }

  /** True when the token points at a live value. */
  has(token: string): boolean {
    return this.get(token) !== undefined;
  }

  /** Removes a token. Returns whether anything was removed. */
  delete(token: string): boolean {
    return this.entries.delete(token);
  }

  /** Removes everything. */
  clear(): void {
    this.entries.clear();
  }

  /** The number of live entries. Expired entries are swept first. */
  get size(): number {
    this.sweep();

    return this.entries.size;
  }

  /**
   * Removes every expired entry.
   *
   * @returns how many entries were removed.
   */
  sweep(): number {
    const now = this.now();
    let removed = 0;

    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(token);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Stops the sweep timer.
   *
   * Call this when the store's owner shuts down, and in tests.
   */
  stop(): void {
    if (this.timer) {
      // `setInterval` hands back a `Timeout` handle in Node. The handle has
      // `.unref()` but no `.clearInterval()` — the timer is stopped with the
      // global function, which is what takes the handle.
      clearInterval(this.timer);
    }
  }
}
