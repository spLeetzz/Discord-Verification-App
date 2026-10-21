/**
 * The lockdown, proved against the live database.
 *
 * The lockdown row is the state: it says what is locked, and what every
 * channel's permission looked like before. The `jobs` row is the **timer**
 * and nothing else. The channels the lockdown covers are rows of the
 * `lockdown_channels` join table.
 *
 * These tests connect to the SQLite database the bot talks to, because
 * the things they are about — how many rows a lockdown writes, and what
 * the recorded permission state looks like after a re-read — are only
 * true of the database and not of a stand-in for one.
 *
 * The fixtures use ids no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import type { Channel, Guild, GuildMember, Role } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { lockdownChannels, lockdowns } from "../../db/schema.js";
import { evaluateLock, evaluateUnlock } from "./lock-state.js";
import { lockChannel, lockServer, releaseLock, unlockServer } from "./lockdown.js";
import type { LockContext, LockableChannel } from "./lockdown.js";
import {
  createLockdown,
  findLockdown,
  listLockdownJobs,
  listLockdowns,
  parseLockdownJobPayload,
  removeLockdown,
} from "./repo.js";
import type { LockRecord } from "./types.js";

/**
 * The database this file runs against.
 *
 * **A file of its own.** SQLite has one writer, so two test files that
 * shared a database file would fight over it and fail with
 * `SQLITE_BUSY`. The file is in the system temporary directory, and it is
 * dropped when the run ends.
 *
 * The client reads `DB_FILE` when it is imported and applies the
 * migrations to it as it goes, so the variable has to be set *before*
 * the import of `db/client.js` — which is what `vi.hoisted` is for.
 */
const { databaseFile } = vi.hoisted(() => {
  const directory = process.env.TMPDIR || process.env.TEMP || "/tmp";
  const file = `${directory}/quotient-moderation-lockdown-${process.pid}-${Math.random().toString(36).slice(2)}.db`;

  process.env.DB_FILE = file;

  return { databaseFile: file };
});

/** A run id, so two runs never fight over the same rows. */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The guild every fixture of this file belongs to. */
const GUILD_ID = `lockdown-test-${RUN}`;

/**
 * A second guild, for the tests that need a subject of their own.
 *
 * The key of a server lockdown is the guild, so a guild may only have one
 * of them — a second one would be refused.
 */
const OTHER_GUILD_ID = `lockdown-test-other-${RUN}`;

/** The `@everyone` role of the fake guild. */
const EVERYONE_ID = `lockdown-test-everyone-${RUN}`;

/** A channel id no real row can have. */
function channelId(name: string): string {
  return `lockdown-test-${RUN}-${name}`;
}

/** When the fake lockdown lifts. */
function inAMinute(): Date {
  return new Date(Date.now() + 60_000);
}

/* ------------------------------------------------------------------ *
 * The fake Discord
 * ------------------------------------------------------------------ */

/** What a fake channel recorded about its overwrites. */
interface OverwriteCall {
  readonly kind: "edit" | "delete";
  readonly targetId: string;
  /** The permission that was written, when one was. */
  readonly permission: string | null;
  /** The value it was written with, when one was. */
  readonly value: boolean | null | undefined;
}

/**
 * A channel whose overwrites the test can read afterwards.
 *
 * @param writable whether @everyone may write in it. A server lockdown
 *                 only covers the channels @everyone can write in, so the
 *                 fake has to say yes to `send_messages` — and to
 *                 `manage_channels`, or the bot may not edit it.
 */
function fakeChannel(
  id: string,
  calls: OverwriteCall[],
  /**
   * What happens while the channel is being changed.
   *
   * It is how a test makes the race happen at a chosen moment: the
   * permission is taken away first, and the row is written afterwards.
   */
  onEdit?: () => Promise<void>,
  writable = false,
): LockableChannel {
  return {
    id,
    name: id,
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Map(),
      edit: async (
        target: Role,
        options: Record<string, boolean | null>,
      ): Promise<void> => {
        if (onEdit) await onEdit();

        const permission = Object.keys(options)[0] ?? null;

        calls.push({
          kind: "edit",
          targetId: target.id,
          permission,
          value: permission === null ? null : options[permission],
        });
      },
      delete: async (target: Role): Promise<void> => {
        calls.push({
          kind: "delete",
          targetId: target.id,
          permission: null,
          value: undefined,
        });
      },
    },
    permissionsFor: () => ({
      has: (flag: bigint) =>
        writable || flag === PermissionFlagsBits.ManageChannels,
    }),
  } as unknown as LockableChannel;
}

/** A guild that holds the given channels and nothing else. */
function fakeGuild(
  channels: readonly LockableChannel[],
  guildId: string = GUILD_ID,
): Guild {
  const cache = new Collection<string, Channel>();

  for (const channel of channels) {
    cache.set(channel.id, channel as unknown as Channel);
  }

  return {
    id: guildId,
    channels: { cache },
    roles: { everyone: { id: EVERYONE_ID } },
    members: { me: { id: `lockdown-test-bot-${RUN}` } },
  } as unknown as Guild;
}

/** A moderator running the command. */
function fakeContext(guild: Guild): LockContext {
  return {
    guild,
    author: { id: `lockdown-test-moderator-${RUN}` } as unknown as GuildMember,
    reason: "A test",
    sourceChannelId: null,
  };
}

/** A lockdown of one channel, with the parts a test cares about. */
async function makeLockdown(input: {
  readonly channel: string;
  readonly expireTime: Date | null;
  readonly priorState: Record<string, { existed: boolean; value: boolean | null }>;
}): Promise<LockRecord> {
  const record = await createLockdown({
    guildId: GUILD_ID,
    type: "channel",
    roleId: null,
    channelId: input.channel,
    channelIds: [input.channel],
    expireTime: input.expireTime,
    authorId: `lockdown-test-moderator-${RUN}`,
    priorState: input.priorState,
    sourceChannelId: null,
    maintenanceChannelIds: [],
  });

  if (!record) throw new Error("The lockdown row was refused.");

  return record;
}

/** The key the row of a lockdown was stored under. */
async function storedKey(id: string): Promise<string | undefined> {
  const rows = await db
    .select({ key: lockdowns.lockKey })
    .from(lockdowns)
    .where(eq(lockdowns.id, id));

  return rows[0]?.key;
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

afterAll(async () => {
  // Every fixture of this file belongs to one guild, and a lockdown takes
  // its timer with it.
  for (const record of await listLockdowns(GUILD_ID)) {
    await removeLockdown(record.id);
  }

  for (const record of await listLockdowns(OTHER_GUILD_ID)) {
    await removeLockdown(record.id);
  }

  await closeDatabase();

  rmSync(databaseFile, { force: true });
});

describe("the lockdown row", () => {
  it("keeps the prior state, and gives it back on a re-read", async () => {
    const channel = channelId("round-trip");

    const priorState = {
      [channel]: { existed: true, value: false },
      [channelId("never-locked")]: { existed: false, value: null },
    };

    const record = await makeLockdown({
      channel,
      expireTime: null,
      priorState,
    });

    const read = await findLockdown(GUILD_ID, "channel", channel);

    expect(read?.id).toBe(record.id);
    expect(read?.priorState).toEqual(priorState);
  });

  it("writes no job row when the lockdown has no duration", async () => {
    const record = await makeLockdown({
      channel: channelId("no-duration"),
      expireTime: null,
      priorState: {},
    });

    expect(await listLockdownJobs(record.id)).toEqual([]);

    // The row is still there, with a null expiry: the lock is the state,
    // and only the timer is missing.
    expect(record.expireTime).toBeNull();
  });

  it("writes exactly one job row when the lockdown has a duration", async () => {
    const expireTime = inAMinute();

    const record = await makeLockdown({
      channel: channelId("with-duration"),
      expireTime,
      priorState: {},
    });

    const rows = await listLockdownJobs(record.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt).toEqual(expireTime);

    // The expiry of the lock and the moment the timer comes due are the
    // same instant, down to the millisecond: the scheduler fires the row
    // when `expires_at` has passed.
    expect(record.expireTime).toEqual(expireTime);
    expect(rows[0]?.expiresAt.getTime()).toBe(record.expireTime?.getTime());
  });

  it("writes the channels it covers as rows of the join table", async () => {
    const channel = channelId("covered");

    const record = await makeLockdown({
      channel,
      expireTime: null,
      priorState: {},
    });

    const rows = await db
      .select()
      .from(lockdownChannels)
      .where(eq(lockdownChannels.lockdownId, record.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.channelId).toBe(channel);

    // And the record reads them back the same way.
    expect(record.channelIds).toEqual([channel]);
    expect((await findLockdown(GUILD_ID, "channel", channel))?.channelIds).toEqual(
      [channel],
    );
  });

  it("takes the channel rows with it when the lockdown is lifted", async () => {
    const channel = channelId("rows-lifted");

    const record = await makeLockdown({
      channel,
      expireTime: null,
      priorState: {},
    });

    const before = await db
      .select()
      .from(lockdownChannels)
      .where(eq(lockdownChannels.lockdownId, record.id));

    expect(before).toHaveLength(1);

    await removeLockdown(record.id);

    const after = await db
      .select()
      .from(lockdownChannels)
      .where(eq(lockdownChannels.lockdownId, record.id));

    expect(after).toHaveLength(0);
  });

  it("keeps the permission state out of the job payload", async () => {
    const record = await makeLockdown({
      channel: channelId("payload"),
      expireTime: inAMinute(),
      priorState: {
        [channelId("payload")]: { existed: true, value: false },
      },
    });

    const rows = await listLockdownJobs(record.id);
    const payload = rows[0]?.payload as Record<string, unknown>;

    expect(payload).not.toHaveProperty("prior");
    expect(payload).not.toHaveProperty("priorState");
    expect(JSON.stringify(payload)).not.toContain("existed");

    // The payload still says which lockdown to lift.
    const parsed = parseLockdownJobPayload(payload);

    expect(parsed?.lockdownId).toBe(record.id);
  });

  it("takes its timer with it when the lockdown is lifted", async () => {
    const record = await makeLockdown({
      channel: channelId("lifted"),
      expireTime: inAMinute(),
      priorState: {},
    });

    expect(await listLockdownJobs(record.id)).toHaveLength(1);

    await removeLockdown(record.id);

    expect(await listLockdownJobs(record.id)).toHaveLength(0);
    expect(await findLockdown(GUILD_ID, "channel", channelId("lifted"))).toBeNull();
  });
});

describe("the unlock", () => {
  it("puts an overwrite that existed back to exactly what it was", async () => {
    const channel = channelId("existed");
    const calls: OverwriteCall[] = [];
    const guild = fakeGuild([fakeChannel(channel, calls)]);

    await makeLockdown({
      channel,
      expireTime: null,
      priorState: { [channel]: { existed: true, value: false } },
    });

    const record = await findLockdown(GUILD_ID, "channel", channel);
    if (!record) throw new Error("The lockdown row was not found.");

    const result = await releaseLock({
      context: fakeContext(guild),
      record,
      permission: "SendMessages",
      target: guild.roles.everyone,
      restore: true,
    });

    expect(result.restored).toBe(1);
    expect(result.withoutRecord).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("edit");
    expect(calls[0]?.targetId).toBe(EVERYONE_ID);
    expect(calls[0]?.permission).toBe("SendMessages");
    expect(calls[0]?.value).toBe(false);
  });

  it("removes an overwrite that did not exist before", async () => {
    const channel = channelId("created");
    const calls: OverwriteCall[] = [];
    const guild = fakeGuild([fakeChannel(channel, calls)]);

    await makeLockdown({
      channel,
      expireTime: null,
      priorState: { [channel]: { existed: false, value: null } },
    });

    const record = await findLockdown(GUILD_ID, "channel", channel);
    if (!record) throw new Error("The lockdown row was not found.");

    const result = await releaseLock({
      context: fakeContext(guild),
      record,
      permission: "SendMessages",
      target: guild.roles.everyone,
      restore: true,
    });

    expect(result.restored).toBe(1);
    expect(result.withoutRecord).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("delete");
    expect(calls[0]?.targetId).toBe(EVERYONE_ID);
  });

  it("resets the permission to inherit when the row records nothing", async () => {
    const channel = channelId("no-record");
    const calls: OverwriteCall[] = [];
    const guild = fakeGuild([fakeChannel(channel, calls)]);

    await makeLockdown({
      channel,
      expireTime: null,
      priorState: {},
    });

    const record = await findLockdown(GUILD_ID, "channel", channel);
    if (!record) throw new Error("The lockdown row was not found.");

    const result = await releaseLock({
      context: fakeContext(guild),
      record,
      permission: "SendMessages",
      target: guild.roles.everyone,
      restore: true,
    });

    expect(result.restored).toBe(0);
    expect(result.withoutRecord).toBe(1);
    expect(calls[0]?.kind).toBe("edit");
    expect(calls[0]?.value).toBeNull();
  });
});

describe("the double-lock guard", () => {
  it("refuses a second lock on a channel that is locked with a duration", async () => {
    const channel = channelId("guarded-with-duration");

    await makeLockdown({ channel, expireTime: inAMinute(), priorState: {} });

    const decision = evaluateLock(
      {
        type: "channel",
        guildId: GUILD_ID,
        channelId: channel,
        channelIds: [channel],
        roleId: null,
        expireTime: null,
        authorId: `lockdown-test-moderator-${RUN}`,
        channelName: "general",
      },
      await listLockdowns(GUILD_ID),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "already locked",
    );
  });

  it("refuses a second lock on a channel that is locked with no duration", async () => {
    const channel = channelId("guarded-no-duration");

    await makeLockdown({ channel, expireTime: null, priorState: {} });

    const decision = evaluateLock(
      {
        type: "channel",
        guildId: GUILD_ID,
        channelId: channel,
        channelIds: [channel],
        roleId: null,
        expireTime: null,
        authorId: `lockdown-test-moderator-${RUN}`,
        channelName: "general",
      },
      await listLockdowns(GUILD_ID),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "already locked",
    );
  });
});

describe("the lock key", () => {
  it("stores the key of the subject a channel lockdown is about", async () => {
    const channel = channelId("key-channel");

    const record = await makeLockdown({ channel, expireTime: null, priorState: {} });

    expect(await storedKey(record.id)).toBe(`channel:${channel}`);
  });

  it("stores the key of the subject a maintenance lockdown is about", async () => {
    const record = await createLockdown({
      guildId: GUILD_ID,
      type: "maintenance",
      roleId: EVERYONE_ID,
      channelId: null,
      channelIds: [],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!record) throw new Error("The lockdown row was refused.");

    expect(await storedKey(record.id)).toBe(`maintenance:${EVERYONE_ID}`);
  });

  it("stores the key of the subject a server lockdown is about", async () => {
    const record = await createLockdown({
      guildId: GUILD_ID,
      type: "guild",
      roleId: null,
      channelId: null,
      channelIds: [],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!record) throw new Error("The lockdown row was refused.");

    expect(await storedKey(record.id)).toBe(`guild:${GUILD_ID}`);
  });

  it("stores the key of the subject a category lockdown is about", async () => {
    const category = channelId("key-category");

    const record = await createLockdown({
      guildId: GUILD_ID,
      type: "category",
      roleId: null,
      channelId: category,
      channelIds: [],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!record) throw new Error("The lockdown row was refused.");

    expect(await storedKey(record.id)).toBe(`category:${category}`);
  });
});

describe("two lockdowns of the same subject at once", () => {
  it("writes one row, and refuses the other in the database", async () => {
    const channel = channelId("concurrent");

    const input = {
      guildId: GUILD_ID,
      type: "channel" as const,
      roleId: null,
      channelId: channel,
      channelIds: [channel],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    };

    // Both go in at once, and neither of them reads the table first: the
    // refusal comes from the unique constraint, not from a guard.
    const [first, second] = await Promise.all([
      createLockdown(input),
      createLockdown(input),
    ]);

    expect([first, second].filter((record) => record !== null)).toHaveLength(1);
    expect([first, second].filter((record) => record === null)).toHaveLength(1);

    // One row, and one row only.
    const rows = await db
      .select()
      .from(lockdowns)
      .where(eq(lockdowns.lockKey, `channel:${channel}`));

    expect(rows).toHaveLength(1);
  });

  it("refuses the second lockdown with the good message", async () => {
    const channel = channelId("concurrent-command");
    const calls: OverwriteCall[] = [];
    const lockable = fakeChannel(channel, calls);
    const guild = fakeGuild([lockable]);

    const results = await Promise.allSettled([
      lockChannel({ context: fakeContext(guild), channel: lockable, duration: null }),
      lockChannel({ context: fakeContext(guild), channel: lockable, duration: null }),
    ]);

    const refused = results.filter((result) => result.status === "rejected");

    expect(refused).toHaveLength(1);

    const reason =
      refused[0]?.status === "rejected" ? String(refused[0].reason) : "";

    expect(reason).toContain("already locked");

    // And the guild has one lockdown of that channel, not two.
    const rows = await db
      .select()
      .from(lockdowns)
      .where(eq(lockdowns.lockKey, `channel:${channel}`));

    expect(rows).toHaveLength(1);
  });

  it("refuses a lockdown the database refuses, and says until when", async () => {
    const channel = channelId("refused-by-the-database");
    const calls: OverwriteCall[] = [];

    // The other moderator gets there first: their row is written while
    // this lockdown is changing the channel's permissions, so the guard
    // has already said yes and the insert is the one that refuses.
    const lockable = fakeChannel(channel, calls, async () => {
      await createLockdown({
        guildId: GUILD_ID,
        type: "channel",
        roleId: null,
        channelId: channel,
        channelIds: [channel],
        expireTime: inAMinute(),
        authorId: `lockdown-test-other-moderator-${RUN}`,
        priorState: {},
        sourceChannelId: null,
        maintenanceChannelIds: [],
      });
    });

    const guild = fakeGuild([lockable]);

    let reason = "";

    try {
      await lockChannel({
        context: fakeContext(guild),
        channel: lockable,
        duration: null,
      });
    } catch (error) {
      reason = String(error);
    }

    // The refusal is the guard's message, with the time left of the
    // lockdown that won.
    expect(reason).toContain("already locked");
    expect(reason).toContain("It unlocks in 1 minute.");

    // One row for the subject, and one only.
    const rows = await db
      .select()
      .from(lockdowns)
      .where(eq(lockdowns.lockKey, `channel:${channel}`));

    expect(rows).toHaveLength(1);

    // And the winning lockdown stands: the channel is still write-locked,
    // because the row that will lift it is the one that is there.
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(0);
    expect(calls.filter((call) => call.kind === "edit")).toHaveLength(1);
  });
});

describe("the constraint that refuses a second lockdown", () => {
  it("refuses a second row for the same subject in the database itself", async () => {
    const channel = channelId("constraint");

    await makeLockdown({ channel, expireTime: null, priorState: {} });

    // The insert does not go through the repository: it is a plain
    // insert, so the only thing that can refuse it is the unique
    // constraint on `lockdowns.lock_key`. This is what makes the refusal
    // a fact of the database and not a fact of a read-then-write check.
    let failure: unknown = null;

    try {
      await db.insert(lockdowns).values({
        guildId: GUILD_ID,
        type: "channel",
        roleId: null,
        channelId: channel,
        expireTime: null,
        priorState: {},
        authorId: `lockdown-test-moderator-${RUN}`,
        lockKey: `channel:${channel}`,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).not.toBeNull();

    // The driver wraps the error; the constraint is in the cause.
    const cause = (failure as { cause?: unknown }).cause ?? failure;

    expect(String(cause)).toMatch(/UNIQUE constraint failed/i);
    expect(String(cause)).toContain("lockdowns.lock_key");

    // And there is still one row for the subject.
    const rows = await db
      .select()
      .from(lockdowns)
      .where(eq(lockdowns.lockKey, `channel:${channel}`));

    expect(rows).toHaveLength(1);
  });
});

describe("a server lockdown", () => {
  it("covers the channels it locked, and releases exactly them", async () => {
    const first = channelId("server-first");
    const second = channelId("server-second");
    const calls: OverwriteCall[] = [];

    const guild = fakeGuild(
      [
        fakeChannel(first, calls, undefined, true),
        fakeChannel(second, calls, undefined, true),
      ],
      OTHER_GUILD_ID,
    );

    const locked = await lockServer({
      context: fakeContext(guild),
      duration: null,
    });

    expect(locked.locked).toBe(2);

    const record = await findLockdown(OTHER_GUILD_ID, "guild");
    if (!record) throw new Error("The lockdown row was not found.");

    // The join table holds the two channels the server lockdown covered,
    // and nothing else.
    expect(record.channelIds).toEqual([first, second]);

    const rows = await db
      .select()
      .from(lockdownChannels)
      .where(eq(lockdownChannels.lockdownId, record.id));

    expect(rows.map((row) => row.channelId).sort()).toEqual([first, second]);

    // And the unlock puts exactly those two back.
    const released = await unlockServer(fakeContext(guild));

    expect(released.restored).toBe(2);
    expect(released.failed).toBe(0);

    expect(calls.filter((call) => call.kind === "edit")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(2);

    // The rows of the channels it covered go with it.
    const after = await db
      .select()
      .from(lockdownChannels)
      .where(eq(lockdownChannels.lockdownId, record.id));

    expect(after).toHaveLength(0);
  });
});

describe("the order of the lockdowns", () => {
  it("lists the lockdowns of a guild in the order they were made", async () => {
    const older = channelId("order-older");
    const newer = channelId("order-newer");

    // The lockdown that was made first is written to the table last: the
    // order comes from the row, not from the order of the writes.
    await makeLockdown({ channel: newer, expireTime: null, priorState: {} });

    const written = await db
      .insert(lockdowns)
      .values({
        guildId: GUILD_ID,
        type: "channel",
        roleId: null,
        channelId: older,
        expireTime: null,
        priorState: {},
        authorId: `lockdown-test-moderator-${RUN}`,
        lockKey: `channel:${older}`,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      })
      .returning({ id: lockdowns.id });

    const row = written[0];
    if (!row) throw new Error("The lockdown row was not written.");

    // The channel it covers is a row of the join table, not a column of
    // the lockdown.
    await db.insert(lockdownChannels).values({
      lockdownId: row.id,
      channelId: older,
    });

    const order = (await listLockdowns(GUILD_ID)).map((record) => record.channelId);

    expect(order.indexOf(older)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(older)).toBeLessThan(order.indexOf(newer));
  });

  it("lifts the row it means to, every time", async () => {
    const channel = channelId("lifted-by-key");

    const channelLock = await createLockdown({
      guildId: OTHER_GUILD_ID,
      type: "channel",
      roleId: null,
      channelId: channel,
      channelIds: [channel],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!channelLock) throw new Error("The lockdown row was refused.");

    const guildLock = await createLockdown({
      guildId: OTHER_GUILD_ID,
      type: "guild",
      roleId: null,
      channelId: null,
      channelIds: [],
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!guildLock) throw new Error("The lockdown row was refused.");

    const channelRequest = {
      type: "channel" as const,
      guildId: OTHER_GUILD_ID,
      channelId: channel,
      channelIds: [channel],
      roleId: null,
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
    };

    const guildRequest = {
      type: "guild" as const,
      guildId: OTHER_GUILD_ID,
      channelId: null,
      channelIds: [],
      roleId: null,
      expireTime: null,
      authorId: `lockdown-test-moderator-${RUN}`,
    };

    for (const _round of [1, 2]) {
      const existing = await listLockdowns(OTHER_GUILD_ID);

      const channelDecision = evaluateUnlock(channelRequest, existing);
      const guildDecision = evaluateUnlock(guildRequest, existing);

      expect(channelDecision.allowed).toBe(true);
      expect(channelDecision.allowed && channelDecision.record?.id).toBe(
        channelLock.id,
      );
      expect(guildDecision.allowed).toBe(true);
      expect(guildDecision.allowed && guildDecision.record?.id).toBe(
        guildLock.id,
      );
    }
  });
});
