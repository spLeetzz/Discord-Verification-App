/**
 * The channel cache.
 *
 * The cache is the area's answer to "is this channel one of ours?", and a
 * message listener asks it on **every** message — so it must not touch
 * the database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    listTagCheckChannelIds: vi.fn(),
    listEasyTagChannelIds: vi.fn(),
    listSsConfigChannelIds: vi.fn(),
  },
}));

vi.mock("./repo.js", () => mocks.repo);

const cache = await import("./cache.js");

beforeEach(() => {
  vi.clearAllMocks();

  cache.clearChannelCache();

  mocks.repo.listTagCheckChannelIds.mockResolvedValue([]);
  mocks.repo.listEasyTagChannelIds.mockResolvedValue([]);
  mocks.repo.listSsConfigChannelIds.mockResolvedValue([]);
});

describe("the cache", () => {
  it("knows a channel it was told about", () => {
    cache.cacheChannel("tagcheck", "channel-1");

    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(true);
  });

  it("does not know a channel it was not told about", () => {
    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(false);
  });

  it("forgets a channel", () => {
    cache.cacheChannel("tagcheck", "channel-1");
    cache.uncacheChannel("tagcheck", "channel-1");

    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(false);
  });

  it("keeps the three sets apart", () => {
    // A tag-check channel and an easy-tag channel are different things, so
    // one set must not evict another's channels.
    cache.cacheChannel("tagcheck", "channel-1");

    expect(cache.isCachedChannel("easytag", "channel-1")).toBe(false);
    expect(cache.isCachedChannel("ssverify", "channel-1")).toBe(false);

    cache.uncacheChannel("tagcheck", "channel-1");

    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(false);
  });

  it("counts what it holds", () => {
    cache.cacheChannel("tagcheck", "channel-1");
    cache.cacheChannel("ssverify", "channel-2");

    expect(cache.channelCacheSizes()).toEqual({
      tagcheck: 1,
      easytag: 0,
      ssverify: 1,
    });
  });

  it("empties every set at once", () => {
    cache.cacheChannel("tagcheck", "channel-1");
    cache.cacheChannel("easytag", "channel-2");
    cache.cacheChannel("ssverify", "channel-3");

    cache.clearChannelCache();

    expect(cache.channelCacheSizes()).toEqual({
      tagcheck: 0,
      easytag: 0,
      ssverify: 0,
    });
  });
});

describe("loading the cache", () => {
  it("takes the channel ids out of the database", async () => {
    mocks.repo.listTagCheckChannelIds.mockResolvedValue(["channel-1"]);
    mocks.repo.listEasyTagChannelIds.mockResolvedValue(["channel-2"]);
    mocks.repo.listSsConfigChannelIds.mockResolvedValue(["channel-3"]);

    await cache.loadChannelCache();

    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(true);
    expect(cache.isCachedChannel("easytag", "channel-2")).toBe(true);
    expect(cache.isCachedChannel("ssverify", "channel-3")).toBe(true);
  });

  it("keeps what it had when the database is unavailable", async () => {
    // A database that is briefly down must not empty a cache that was
    // working, or the bot stops answering registrations until the next
    // rebuild.
    cache.cacheChannel("tagcheck", "channel-1");

    mocks.repo.listTagCheckChannelIds.mockRejectedValue(
      new Error("the database is down"),
    );

    await expect(cache.loadChannelCache()).rejects.toThrow();

    expect(cache.isCachedChannel("tagcheck", "channel-1")).toBe(true);
  });
});
