/**
 * The channel cache.
 *
 * Quotient kept three in-memory sets of channel ids — `tagcheck`,
 * `eztagchannels` and `ssverify_channels` — filled at startup and pruned
 * when a record vanished. The point was to avoid a database round trip on
 * every message, and that point still stands.
 *
 * D21 puts the shared cache in `core/channel-cache.ts`, and the scrims
 * area already uses it. This module is the identity area's **instances**:
 * a tag-check channel, an easy-tag channel and a screenshot-verification
 * channel are different things, so the three sets are not shared — a
 * listener that finds no record for a cached channel removes that channel
 * from the cache, and a shared set would let one set evict another's
 * channels.
 *
 * The cache is **only ever a hint**. A channel id in the cache does not
 * mean the row exists, and the row is always read before anything is
 * written — a cache that is trusted for a decision is a cache that can be
 * wrong.
 */

import { ChannelIdCache } from "../../core/channel-cache.js";
import * as repo from "./repo.js";

/** Which set a channel id belongs to. */
export type CachedChannelKind = "tagcheck" | "easytag" | "ssverify";

/**
 * The three sets.
 *
 * One instance per kind — see the note at the top of the file.
 */
const caches: Record<CachedChannelKind, ChannelIdCache> = {
  tagcheck: new ChannelIdCache(),
  easytag: new ChannelIdCache(),
  ssverify: new ChannelIdCache(),
};

/**
 * Reads every configured channel of every kind out of the database.
 *
 * Called once at startup. A loader that throws leaves the cache as it
 * was, so a database that is briefly unavailable does not empty a cache
 * that was working.
 */
export async function loadChannelCache(): Promise<void> {
  await Promise.all([
    caches.tagcheck.rebuild(() => repo.listTagCheckChannelIds()),
    caches.easytag.rebuild(() => repo.listEasyTagChannelIds()),
    caches.ssverify.rebuild(() => repo.listSsConfigChannelIds()),
  ]);
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
  return caches[kind].has(channelId);
}

/**
 * Adds a channel to a set.
 */
export function cacheChannel(kind: CachedChannelKind, channelId: string): void {
  caches[kind].add(channelId);
}

/**
 * Removes a channel from a set.
 */
export function uncacheChannel(
  kind: CachedChannelKind,
  channelId: string,
): void {
  caches[kind].remove(channelId);
}

/**
 * Empties every set.
 *
 * For the tests.
 */
export function clearChannelCache(): void {
  caches.tagcheck.clear();
  caches.easytag.clear();
  caches.ssverify.clear();
}

/**
 * How many channels are cached, per kind.
 *
 * For the diagnostics and the tests.
 */
export function channelCacheSizes(): Record<CachedChannelKind, number> {
  return {
    tagcheck: caches.tagcheck.size,
    easytag: caches.easytag.size,
    ssverify: caches.ssverify.size,
  };
}
