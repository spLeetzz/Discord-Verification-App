/**
 * The channel cache.
 *
 * Quotient kept three in-memory sets of channel ids — `tagcheck`,
 * `eztagchannels` and `ssverify_channels` — filled at startup and pruned
 * when a record vanished. The point was to avoid a database round trip on
 * every message, and that point still stands.
 *
 * D21 puts the shared cache in `core/channel-cache.ts`, which is the
 * manager's file. Until it exists, this module keeps its own cache; it is
 * the same shape, so moving it later is a matter of swapping the
 * implementation and not the call sites.
 *
 * The cache is **only ever a hint**. A channel id in the cache does not
 * mean the row exists, and the row is always read before anything is
 * written — a cache that is trusted for a decision is a cache that can be
 * wrong.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { easytagChannels, ssConfigs, tagcheckChannels } from "../../db/schema.js";

/** Which set a channel id belongs to. */
export type CachedChannelKind = "tagcheck" | "easytag" | "ssverify";

const sets: Record<CachedChannelKind, Set<string>> = {
  tagcheck: new Set<string>(),
  easytag: new Set<string>(),
  ssverify: new Set<string>(),
};

/**
 * Reads every configured channel of every kind out of the database.
 *
 * Called once at startup.
 */
export async function loadChannelCache(): Promise<void> {
  const [tagcheck, easytag, ssverify] = await Promise.all([
    db
      .select({ channelId: tagcheckChannels.channelId })
      .from(tagcheckChannels),
    db
      .select({ channelId: easytagChannels.channelId })
      .from(easytagChannels),
    db.select({ channelId: ssConfigs.channelId }).from(ssConfigs),
  ]);

  sets.tagcheck = new Set(tagcheck.map((row) => row.channelId));
  sets.easytag = new Set(easytag.map((row) => row.channelId));
  sets.ssverify = new Set(ssverify.map((row) => row.channelId));
}

/**
 * Is this channel one of ours?
 *
 * @param kind  which set to look in.
 * @param channelId the channel.
 */
export function isCachedChannel(
  kind: CachedChannelKind,
  channelId: string,
): boolean {
  return sets[kind].has(channelId);
}

/**
 * Adds a channel to a set.
 */
export function cacheChannel(kind: CachedChannelKind, channelId: string): void {
  sets[kind].add(channelId);
}

/**
 * Removes a channel from a set.
 */
export function uncacheChannel(
  kind: CachedChannelKind,
  channelId: string,
): void {
  sets[kind].delete(channelId);
}

/**
 * Empties every set.
 *
 * For the tests.
 */
export function clearChannelCache(): void {
  sets.tagcheck.clear();
  sets.easytag.clear();
  sets.ssverify.clear();
}

/**
 * How many channels are cached, per kind.
 *
 * For the diagnostics and the tests.
 */
export function channelCacheSizes(): Record<CachedChannelKind, number> {
  return {
    tagcheck: sets.tagcheck.size,
    easytag: sets.easytag.size,
    ssverify: sets.ssverify.size,
  };
}

/**
 * A count of rows, used by the free-tier checks.
 *
 * Kept here so the two callers of the count share one query shape.
 */
export async function countRows(table: "tagcheck" | "easytag" | "ssverify"): Promise<number> {
  const source =
    table === "tagcheck"
      ? tagcheckChannels
      : table === "easytag"
        ? easytagChannels
        : ssConfigs;

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(source);

  return row?.count ?? 0;
}
