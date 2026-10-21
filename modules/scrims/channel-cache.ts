/**
 * The registration-channel cache.
 *
 * A `Set` of the ids of the channels that accept scrim registrations.
 * It is rebuilt at startup and refreshed when a scrim opens or closes.
 *
 * The point is that the registration listener must **not** hit the
 * database for every message it sees: a busy server sends thousands of
 * messages an hour, and only a handful are registrations.
 *
 * D21 puts the shared version of this in `core/channel-cache.ts`, which
 * has not landed. This is the scrims area's own copy; when the core one
 * arrives, this file goes away and the service imports the core cache.
 */

export class ScrimChannelCache {
  private readonly channels = new Set<string>();

  /** Is this channel a registration channel? */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** Starts accepting registrations in a channel. */
  add(channelId: string): void {
    this.channels.add(channelId);
  }

  /** Stops accepting registrations in a channel. */
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
}

/** The cache the service uses. */
export const scrimChannelCache = new ScrimChannelCache();
