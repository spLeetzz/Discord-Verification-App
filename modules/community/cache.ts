/**
 * The auto-purge channel cache.
 *
 * The auto-purge listener runs on **every message**, so it must not ask
 * the database about every message it sees. The source kept a set of
 * channel ids in the bot's cache for exactly this reason (D21).
 *
 * One place owns the invalidation: the set is rebuilt from the database
 * at startup, and the commands that add or remove a channel update it
 * straight away.
 */

export class AutoPurgeChannelCache {
  private readonly channels = new Set<string>();

  /** Throws the cache away and fills it again. */
  replace(ids: readonly string[]): void {
    this.channels.clear();

    for (const id of ids) this.channels.add(id);
  }

  /** Adds a channel. */
  add(id: string): void {
    this.channels.add(id);
  }

  /** Removes a channel. */
  discard(id: string): void {
    this.channels.delete(id);
  }

  /** Is this channel an auto-purge channel? */
  has(id: string): boolean {
    return this.channels.has(id);
  }

  /** How many channels are in the cache. */
  get size(): number {
    return this.channels.size;
  }
}

/** The cache the auto-purge listener reads. */
export const autoPurgeChannels = new AutoPurgeChannelCache();
