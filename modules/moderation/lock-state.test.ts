/**
 * The lockdown state machine.
 *
 * The transitions and their guards. The rules are pure, so they are
 * tested without a database and without Discord — which is the point of
 * putting them in their own file.
 */

import { describe, expect, it } from "vitest";
import { evaluateLock, evaluateUnlock, findCoveringLock, lockKey } from "./lock-state.js";
import type { LockRecord } from "./types.js";

/** A lockdown row, with the parts a test cares about overridden. */
function record(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    id: "lock-1",
    guildId: "guild-1",
    type: "channel",
    roleId: null,
    channelId: "channel-1",
    channelIds: ["channel-1"],
    expireTime: null,
    priorState: null,
    authorId: "author-1",
    sourceChannelId: "channel-1",
    ...overrides,
  };
}

/** A lock request, with the parts a test cares about overridden. */
function request(overrides: Partial<Parameters<typeof evaluateLock>[0]> = {}) {
  return {
    type: "channel" as const,
    guildId: "guild-1",
    channelId: "channel-1",
    channelIds: ["channel-1"],
    roleId: null,
    expireTime: null,
    authorId: "author-1",
    ...overrides,
  };
}

describe("lockKey", () => {
  it("gives a channel lockdown a key of its own", () => {
    expect(lockKey({ guildId: "g", type: "channel", channelId: "c", roleId: null })).toBe(
      "g:channel:c",
    );
  });

  it("gives a maintenance lockdown a key of its own", () => {
    expect(lockKey({ guildId: "g", type: "maintenance", channelId: null, roleId: "r" })).toBe(
      "g:maintenance:r",
    );
  });

  it("gives a server lockdown a key of its own", () => {
    expect(lockKey({ guildId: "g", type: "guild", channelId: null, roleId: null })).toBe(
      "g:guild",
    );
  });
});

describe("evaluateLock", () => {
  it("allows a channel that is not locked", () => {
    expect(evaluateLock(request(), [])).toEqual({ allowed: true });
  });

  it("refuses a second lock on the same channel", () => {
    const existing = [record({ type: "channel", channelId: "channel-1" })];

    const decision = evaluateLock(request(), existing);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "already locked",
    );
  });

  it("allows a different channel", () => {
    const existing = [record({ type: "channel", channelId: "channel-2" })];

    expect(evaluateLock(request(), existing)).toEqual({ allowed: true });
  });

  it("refuses a second server lockdown", () => {
    const existing = [
      record({ type: "guild", channelId: null, channelIds: ["channel-1"] }),
    ];

    const decision = evaluateLock(
      request({ type: "guild", channelId: null, channelIds: [] }),
      existing,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "server is already locked",
    );
  });

  it("refuses a second maintenance lockdown for the same role", () => {
    const existing = [
      record({ type: "maintenance", roleId: "role-1", channelId: null }),
    ];

    const decision = evaluateLock(
      request({ type: "maintenance", roleId: "role-1", channelId: null }),
      existing,
    );

    expect(decision.allowed).toBe(false);
  });

  it("allows maintenance mode for a different role", () => {
    const existing = [
      record({ type: "maintenance", roleId: "role-1", channelId: null }),
    ];

    const decision = evaluateLock(
      request({ type: "maintenance", roleId: "role-2", channelId: null }),
      existing,
    );

    expect(decision.allowed).toBe(true);
  });

  it("says how long is left when the lockdown has an expiry", () => {
    const now = 1_700_000_000_000;
    const existing = [
      record({
        type: "channel",
        channelId: "channel-1",
        expireTime: new Date(now + 3_600_000),
      }),
    ];

    const decision = evaluateLock(request(), existing, now);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "It unlocks in 1 hour.",
    );
  });

  it("says nothing about the time when the lockdown has none", () => {
    const existing = [record({ type: "channel", channelId: "channel-1" })];

    const decision = evaluateLock(request(), existing);

    expect(decision.allowed === false && decision.reason).not.toContain(
      "It unlocks",
    );
  });
});

describe("findCoveringLock", () => {
  it("finds the server lockdown that covers a channel", () => {
    const guildLock = record({
      type: "guild",
      channelId: null,
      channelIds: ["channel-1", "channel-2"],
    });

    expect(findCoveringLock("channel-2", [guildLock])).toBe(guildLock);
  });

  it("does not treat a channel's own lockdown as covering it", () => {
    const channelLock = record({ type: "channel", channelId: "channel-1" });

    expect(findCoveringLock("channel-1", [channelLock])).toBeNull();
  });
});

describe("evaluateUnlock", () => {
  it("allows a channel that is locked", () => {
    const existing = [record({ type: "channel", channelId: "channel-1" })];

    const decision = evaluateUnlock(request(), existing);

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.record?.id).toBe("lock-1");
    expect(decision.allowed && decision.restore).toBe(true);
  });

  it("refuses to unlock a channel that is not locked", () => {
    const decision = evaluateUnlock(request(), []);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "not locked",
    );
  });

  it("refuses to unlock one channel of a server lockdown", () => {
    const existing = [
      record({
        type: "guild",
        channelId: null,
        channelIds: ["channel-1", "channel-2"],
      }),
    ];

    const decision = evaluateUnlock(request(), existing);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "/unlock server",
    );
  });

  it("points at maintenance mode when that is what covers the channel", () => {
    const existing = [
      record({
        type: "maintenance",
        roleId: "role-1",
        channelId: null,
        channelIds: ["channel-1"],
      }),
    ];

    const decision = evaluateUnlock(request(), existing);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "/maintenance off",
    );
  });

  it("refuses to unlock a server that is not locked", () => {
    const decision = evaluateUnlock(
      request({ type: "guild", channelId: null, channelIds: [] }),
      [],
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe(
      "The server is not locked.",
    );
  });

  it("refuses to turn maintenance mode off for a role that is not under it", () => {
    const decision = evaluateUnlock(
      request({ type: "maintenance", roleId: "role-1", channelId: null }),
      [],
    );

    expect(decision.allowed).toBe(false);
  });

  it("allows a category to be unhidden even without a record", () => {
    const decision = evaluateUnlock(
      request({ type: "category", channelId: "category-1", channelIds: [] }),
      [],
    );

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.record).toBeNull();
    expect(decision.allowed && decision.restore).toBe(false);
  });
});
