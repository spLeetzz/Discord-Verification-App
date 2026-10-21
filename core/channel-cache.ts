/**
 * The channel-id cache (D21).
 *
 * A `Set` of channel ids, rebuilt from the database at startup and
 * refreshed when the thing that owns it opens, closes or is edited.
 *
 * The point is that a message listener must **not** hit the database for
 * every message it sees: a busy server sends thousands of messages an
 * hour, and only a handful are registrations.
 *
 * **The cache is only ever a hint.** A channel id in the cache does not
 * mean the row still exists, and the row is always read before anything
 * is written. A cache that is trusted for a decision is a cache that can
 * be wrong.
 *
 * `core/` cannot import `db/` — the runtime layer must not depend on the
 * storage layer, or every test of a guard would need a database. So the
 * rebuild takes a **loader**: the area hands in the query, and the cache
 * owns the invalidation.
 *
 * ```ts
 * const cache = new ChannelIdCache();
 *
 * await cache.rebuild(async () => {
 *   const scrims = await repo.listOpenScrims();
 *
 *   return scrims.map((scrim) => scrim.registrationChannelId);
 * });
 * ```
 *
 * **One instance per set.** A scrim registration channel and a tourney
 * registration channel are different things, so the two areas must not
 * share one set: a listener that finds no record for a cached channel
 * removes that channel from the cache, and a shared set would let one
 * area evict the other area's channels.
 */

/**
 * Loads the channel ids of a set.
 *
 * The area's own query. It is a function so that `core/` never has to
 * know about the database.
 */
export type ChannelIdLoader = () => Promise<Iterable<string>>;

/**
 * A set of channel ids.
 *
 * The class is deliberately dull: it holds ids, it answers questions
 * about them, and it can be rebuilt from the database. Everything
 * scrims-specific lives in the area that owns the set.
 */
export class ChannelIdCache {
  private readonly channels = new Set<string>();

  /** Is this channel in the set? */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** Starts accepting this channel. */
  add(channelId: string): void {
    this.channels.add(channelId);
  }

  /** Stops accepting this channel. */
  remove(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** Replaces the whole set. */
  replace(channelIds: Iterable<string>): void {
    this.channels.clear();

    for (const channelId of channelIds) {
      this.channels.add(channelId);
    }
  }

  /** Empties the cache. */
  clear(): void {
    this.channels.clear();
  }

  /** How many channels are cached. */
  get size(): number {
    return this.channels.size;
  }

  /** A copy of the cached ids. */
  values(): string[] {
    return [...this.channels];
  }

  /**
   * Rebuilds the set from the database.
   *
   * A loader that throws leaves the cache as it was: a database that is
   * briefly unavailable must not empty a cache that was working, or the
   * bot stops answering registrations until the next rebuild.
   *
   * @param load the area's query. It returns the ids of the channels
   *             that are currently open.
   */
  async rebuild(load: ChannelIdLoader): Promise<void> {
    const channelIds = await load();

    this.replace(channelIds);
  }
}
