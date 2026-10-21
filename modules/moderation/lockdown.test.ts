/**
 * The lockdown, proved against the live database.
 *
 * The lockdown row is the state: it says what is locked, and what every
 * channel's permission looked like before. The `jobs` row is the **timer**
 * and nothing else.
 *
 * These tests connect to the Postgres the bot talks to, because the things
 * they are about — how many rows a lockdown writes, and what the recorded
 * permission state looks like after a re-read — are only true of the
 * database and not of a stand-in for one.
 *
 * The fixtures use ids no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, describe, expect, it } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import type { Channel, Guild, GuildMember, Role } from "discord.js";
import { closeDatabase } from "../../db/client.js";
import { evaluateLock } from "./lock-state.js";
import { releaseLock } from "./lockdown.js";
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

/** A run id, so two runs never fight over the same rows. */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The guild every fixture of this file belongs to. */
const GUILD_ID = `lockdown-test-${RUN}`;

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

/** A channel whose overwrites the test can read afterwards. */
function fakeChannel(id: string, calls: OverwriteCall[]): LockableChannel {
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
      has: (flag: bigint) => flag === PermissionFlagsBits.ManageChannels,
    }),
  } as unknown as LockableChannel;
}

/** A guild that holds the given channels and nothing else. */
function fakeGuild(channels: readonly LockableChannel[]): Guild {
  const cache = new Collection<string, Channel>();

  for (const channel of channels) {
    cache.set(channel.id, channel as unknown as Channel);
  }

  return {
    id: GUILD_ID,
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
  return createLockdown({
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

  await closeDatabase();
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
