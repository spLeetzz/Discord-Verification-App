/**
 * Rate limiting.
 *
 * D39: Quotient's cog-level `bot_check` applied a rate limit to every
 * command — two commands per ten seconds per member — and it also limited
 * the screenshot-verification intake (one per seven seconds per member,
 * ten per minute per guild). In this codebase the dispatcher applies the
 * limiter, so the limiter itself has to live in `core/`.
 *
 * Two bucket shapes, because the two limits want different things:
 *
 *  - a **guild** bucket is a sliding window. Ten submissions spread over a
 *    minute is different from ten submissions inside three seconds, and a
 *    sliding window is the only shape that can tell the difference.
 *  - every other bucket (member, user, channel) is a simple timestamp: one
 *    hit per window. A member who runs three commands a second should be
 *    slowed down, not counted.
 *
 * The clock is injectable, so the tests do not have to sleep.
 */

/** Which kind of thing the limit is counted against. */
export type BucketType = "member" | "guild" | "channel" | "user";

/** How a limiter is configured. */
export interface RateLimiterOptions {
  /** How many hits are allowed per window. */
  limit: number;
  /** The length of the window, in milliseconds. */
  windowMs: number;
  /**
   * The bucket shape.
   *
   * `"guild"` uses a sliding window; everything else uses a simple
   * timestamp. Defaults to `"member"`.
   */
  bucket?: BucketType;
  /** The clock. Injectable so tests do not have to sleep. */
  now?: () => number;
}

/**
 * A rate limiter.
 *
 * One instance holds the state for one (limit, window, bucket) triple. The
 * key is whatever identifies the thing being limited — a member id, a
 * guild id, a channel id.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly bucket: BucketType;
  private readonly now: () => number;

  /** Sliding-window state: the timestamps of the hits still in the window. */
  private readonly windows = new Map<string, number[]>();

  /** Simple-timestamp state: the time of the last accepted hit. */
  private readonly stamps = new Map<string, number>();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.bucket = options.bucket ?? "member";
    this.now = options.now ?? Date.now;
  }

  /**
   * Records a hit against a key.
   *
   * @returns `null` when the hit is allowed, or the number of milliseconds
   *          the caller has to wait when it is not.
   *
   * A refused hit is *not* recorded: the window does not slide forward
   * because somebody kept trying.
   */
  hit(key: string): number | null {
    const now = this.now();

    if (this.bucket === "guild") return this.hitWindow(key, now);

    return this.hitTimestamp(key, now);
  }

  /**
   * The sliding-window bucket.
   *
   * Every accepted hit inside the window counts. Once the window is full,
   * the caller waits until the oldest hit falls out of it.
   */
  private hitWindow(key: string, now: number): number | null {
    if (this.limit <= 0) {
      return this.windowMs;
    }

    const hits = this.windows.get(key) ?? [];

    // Drop the hits that have fallen out of the window.
    const cutoff = now - this.windowMs;

    while (hits.length > 0) {
      const oldest = hits[0];

      if (oldest === undefined || oldest > cutoff) break;

      hits.shift();
    }

    if (hits.length >= this.limit) {
      const oldest = hits[0];

      if (oldest !== undefined) {
        return Math.max(0, oldest + this.windowMs - now);
      }
    }

    hits.push(now);
    this.windows.set(key, hits);

    return null;
  }

  /**
   * The simple-timestamp bucket.
   *
   * One hit per window. The timestamp only moves when a hit is accepted.
   */
  private hitTimestamp(key: string, now: number): number | null {
    if (this.limit <= 0) {
      return this.windowMs;
    }

    const last = this.stamps.get(key);

    if (last !== undefined) {
      const elapsed = now - last;

      if (elapsed < this.windowMs) {
        return Math.max(0, this.windowMs - elapsed);
      }
    }

    this.stamps.set(key, now);

    return null;
  }

  /**
   * Forgets one key, or every key.
   */
  reset(key?: string): void {
    if (key === undefined) {
      this.windows.clear();
      this.stamps.clear();
      return;
    }

    this.windows.delete(key);
    this.stamps.delete(key);
  }

  /** How many keys are being tracked. */
  get size(): number {
    return this.bucket === "guild"
      ? this.windows.size
      : this.stamps.size;
  }
}

/**
 * Describes a wait in the way Quotient did.
 *
 * Quotient's messages read `Try again after 4.32 seconds`, and the number
 * is always shown with two decimals so it lines up with the old bot's.
 */
export function describeWait(ms: number): string {
  return `${(ms / 1000).toFixed(2)} seconds`;
}
