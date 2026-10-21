/**
 * An in-memory cache with a time to live.
 *
 * Replaces `aiocache` (D7). There is no Redis: the bot is one process, and
 * a cache that needs a network round trip is not a cache.
 *
 * The name is `ttl-cache.ts` on purpose. `repo/cache.ts` already exists and
 * means the example-image cache; two different things must not share a
 * name.
 *
 * Entries expire on a timer, and a periodic sweep removes the ones nobody
 * looked at. The sweep timer is `unref`ed, so a cache never keeps the
 * process alive on its own.
 */

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

/** How a cache is configured. */
export interface TtlCacheOptions {
  /**
   * How long an entry lives, in milliseconds.
   */
  ttlMs: number;
  /**
   * How often expired entries are swept, in milliseconds.
   *
   * Defaults to 60 seconds.
   */
  sweepIntervalMs?: number;
  /**
   * The most entries the cache holds.
   *
   * When it is full, the oldest entry is dropped. Unlimited by default.
   */
  maxSize?: number;
  /**
   * The clock. Injectable so the tests do not have to sleep.
   */
  now?: () => number;
}

/**
 * A map whose entries expire.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxSize: number | undefined;
  private readonly timer: NodeJS.Timeout | null;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.maxSize = options.maxSize;

    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

    this.timer = setInterval(() => {
      this.sweep();
    }, sweepIntervalMs);

    // The cache is a convenience, not a reason to stay alive.
    this.timer.unref();
  }

  /**
   * Reads a value.
   *
   * An expired entry is dropped and reported as missing.
   */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) return undefined;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Writes a value.
   *
   * @param ttlMs how long *this* entry lives. Defaults to the cache's own
   *              time to live.
   */
  set(key: string, value: V, ttlMs?: number): void {
    // Re-inserting moves the key to the end of the map, which is what makes
    // the eviction below drop the oldest entry rather than an arbitrary one.
    this.entries.delete(key);

    this.entries.set(key, {
      value,
      expiresAt: this.now() + (ttlMs ?? this.ttlMs),
    });

    this.evictIfFull();
  }

  /**
   * True when the key points at a live value.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Removes a key. Returns whether anything was removed.
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Removes everything.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * How many live entries there are. Expired entries are swept first.
   */
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

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Stops the sweep timer.
   *
   * Call this when the cache's owner shuts down, and in tests.
   */
  stop(): void {
    if (this.timer) {
      // `setInterval` hands back a `Timeout` handle in Node. The handle has
      // `.unref()` but no `.clearInterval()` — the timer is stopped with the
      // global function, which is what takes the handle.
      clearInterval(this.timer);
    }
  }

  /**
   * Drops the oldest entry when the cache is over its limit.
   */
  private evictIfFull(): void {
    if (this.maxSize === undefined) return;

    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();

      if (oldest.done) return;

      this.entries.delete(oldest.value);
    }
  }
}
