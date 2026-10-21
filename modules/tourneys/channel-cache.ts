/**
 * The channel caches of the tournaments area.
 *
 * Two sets of channel ids:
 *
 *  - the **registration channels** — the channels a tournament accepts
 *    registrations in;
 *  - the **media-partner channels** — the channels, in *other* guilds,
 *    a tournament accepts registrations through.
 *
 * They are rebuilt at startup and refreshed when a tournament opens,
 * pauses or closes, and when a media partner is added or removed.
 *
 * The point is that the registration listener must **not** hit the
 * database for every message it sees: a busy server sends thousands of
 * messages an hour, and only a handful are registrations.
 *
 * D21 puts the shared version of this in `core/channel-cache.ts`, which
 * has not landed. This is the tournaments area's own copy; when the core
 * one arrives, this file goes away and the service imports the core
 * cache.
 */

/** A set of channel ids. */
export class ChannelIdSet {
  private readonly channels = new Set<string>();

  /** Is this channel in the set? */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** Adds a channel. */
  add(channelId: string): void {
    this.channels.add(channelId);
  }

  /** Removes a channel. */
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

  /** Empties the set. */
  clear(): void {
    this.channels.clear();
  }

  /** How many channels are in the set. */
  get size(): number {
    return this.channels.size;
  }

  /** A copy of the ids. */
  values(): string[] {
    return [...this.channels];
  }
}

/** The registration channels of the tournaments area. */
export const tourneyChannelCache = new ChannelIdSet();

/** The media-partner channels of the tournaments area. */
export const mediaPartnerChannelCache = new ChannelIdSet();
