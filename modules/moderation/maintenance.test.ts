/**
 * The maintenance channels, proved against the live database.
 *
 * The bug this prevents: `maintenance off` deleted the maintenance
 * channels by *name*, so a moderator's own channel called
 * `maintenance-chat` went with them. The channels the bot created are now
 * recorded in the `lockdown_maintenance_channels` join table, and only
 * those are deleted.
 *
 * These tests connect to the SQLite database the bot talks to, because
 * the thing they are about — where the ids of the channels are recorded,
 * and what comes back when they are read — is only true of the database.
 *
 * The fixtures use ids no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import type { Channel, Guild, GuildMember, Role } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { lockdownMaintenanceChannels } from "../../db/schema.js";
import { maintenanceOff, maintenanceOn } from "./lockdown.js";
import type { LockContext, LockableChannel } from "./lockdown.js";
import { describeMaintenanceChannels } from "./maintenance.js";
import {
  createLockdown,
  findLockdown,
  listLockdownJobs,
  listLockdowns,
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
  const file = `${directory}/quotient-moderation-maintenance-${process.pid}-${Math.random().toString(36).slice(2)}.db`;

  process.env.DB_FILE = file;

  return { databaseFile: file };
});

/** A run id, so two runs never fight over the same rows. */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The guild every fixture of this file belongs to. */
const GUILD_ID = `maintenance-test-${RUN}`;

/** The `@everyone` role of the fake guild. */
const EVERYONE_ID = `maintenance-test-everyone-${RUN}`;

/** The bot in the fake guild. */
const BOT_ID = `maintenance-test-bot-${RUN}`;

/** The moderator running the command. */
const MODERATOR_ID = `maintenance-test-moderator-${RUN}`;

/** A channel id no real row can have. */
function channelId(name: string): string {
  return `maintenance-test-${RUN}-${name}`;
}

/* ------------------------------------------------------------------ *
 * The fake Discord
 * ------------------------------------------------------------------ */

/** What a fake channel recorded about its overwrites. */
interface OverwriteCall {
  readonly kind: "edit" | "delete";
  readonly channelId: string;
  readonly targetId: string;
  /** The permission that was written, when one was. */
  readonly permission: string | null;
  /** The value it was written with, when one was. */
  readonly value: boolean | null | undefined;
}

/** A channel that records what was done to it. */
type FakeChannel = LockableChannel & {
  readonly name: string;
  /** How many times the channel was deleted. */
  deletions: number;
};

/**
 * A channel the bot may edit, and a role may see.
 *
 * The bot holds `manage_channels`, and every other role holds
 * `view_channel` — which is what makes a channel a candidate for
 * maintenance mode.
 */
function fakeChannel(
  id: string,
  name: string,
  calls: OverwriteCall[],
): FakeChannel {
  const channel = {
    id,
    name,
    type: ChannelType.GuildText,
    deletions: 0,
    permissionOverwrites: {
      cache: new Map(),
      edit: async (
        target: Role,
        options: Record<string, boolean | null>,
      ): Promise<void> => {
        const permission = Object.keys(options)[0] ?? null;

        calls.push({
          kind: "edit",
          channelId: id,
          targetId: target.id,
          permission,
          value: permission === null ? null : options[permission],
        });
      },
      delete: async (target: Role): Promise<void> => {
        calls.push({
          kind: "delete",
          channelId: id,
          targetId: target.id,
          permission: null,
          value: undefined,
        });
      },
    },
    permissionsFor: (who: { id: string }) => ({
      has: (flag: bigint) =>
        who.id === BOT_ID
          ? flag === PermissionFlagsBits.ManageChannels
          : flag === PermissionFlagsBits.ViewChannel,
    }),
    delete: async (): Promise<void> => {
      channel.deletions += 1;
    },
  };

  return channel as unknown as FakeChannel;
}

/** A guild that holds the given channels and nothing else. */
function fakeGuild(channels: readonly FakeChannel[]): Guild {
  const cache = new Collection<string, Channel>();

  for (const channel of channels) {
    cache.set(channel.id, channel as unknown as Channel);
  }

  return {
    id: GUILD_ID,
    channels: { cache },
    roles: { everyone: { id: EVERYONE_ID, name: "@everyone" } },
    members: { me: { id: BOT_ID } },
  } as unknown as Guild;
}

/** The role the server is put under maintenance for. */
function everyoneRole(): Role {
  return { id: EVERYONE_ID, name: "@everyone" } as unknown as Role;
}

/** A moderator running the command. */
function fakeContext(guild: Guild): LockContext {
  return {
    guild,
    author: { id: MODERATOR_ID } as unknown as GuildMember,
    reason: "A test",
    sourceChannelId: null,
  };
}

/* ------------------------------------------------------------------ *
 * The fixtures
 * ------------------------------------------------------------------ */

/**
 * A maintenance lockdown, with the parts a test cares about.
 *
 * It has no duration, exactly as a maintenance lockdown has in the bot:
 * there is nothing to schedule, and so there is no job row.
 */
async function makeMaintenanceLockdown(input: {
  readonly channelIds: readonly string[];
  readonly maintenanceChannelIds: readonly string[];
}): Promise<LockRecord> {
  const record = await createLockdown({
    guildId: GUILD_ID,
    type: "maintenance",
    roleId: EVERYONE_ID,
    channelId: null,
    channelIds: input.channelIds,
    expireTime: null,
    authorId: MODERATOR_ID,
    priorState: {},
    sourceChannelId: null,
    maintenanceChannelIds: input.maintenanceChannelIds,
  });

  if (!record) throw new Error("The lockdown row was refused.");

  return record;
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

afterEach(async () => {
  // Every fixture of this file belongs to one guild, and a lockdown takes
  // its timer with it.
  for (const record of await listLockdowns(GUILD_ID)) {
    await removeLockdown(record.id);
  }
});

afterAll(async () => {
  await closeDatabase();

  rmSync(databaseFile, { force: true });
});

describe("the maintenance lockdown row", () => {
  it("records the ids of the channels the bot created", async () => {
    const chat = channelId("recorded-chat");
    const voice = channelId("recorded-voice");

    await makeMaintenanceLockdown({
      channelIds: [],
      maintenanceChannelIds: [chat, voice],
    });

    const record = await findLockdown(
      GUILD_ID,
      "maintenance",
      null,
      EVERYONE_ID,
    );

    expect(record?.maintenanceChannelIds).toEqual([chat, voice]);
  });

  it("has no job row to keep them in", async () => {
    // A maintenance lockdown has no duration, so it has no timer row. The
    // ids have nowhere else to live, which is why they are on the row.
    const record = await makeMaintenanceLockdown({
      channelIds: [],
      maintenanceChannelIds: [channelId("no-job-chat")],
    });

    expect(await listLockdownJobs(record.id)).toEqual([]);
  });

  it("leaves the list empty for a lockdown of another type", async () => {
    const channel = channelId("other-type");

    const record = await createLockdown({
      guildId: GUILD_ID,
      type: "channel",
      roleId: null,
      channelId: channel,
      channelIds: [channel],
      expireTime: null,
      authorId: MODERATOR_ID,
      priorState: {},
      sourceChannelId: null,
      // Even when a caller hands it ids, a lockdown that is not a
      // maintenance lockdown has none.
      maintenanceChannelIds: [channelId("never-mine")],
    });

    if (!record) throw new Error("The lockdown row was refused.");

    const read = await findLockdown(GUILD_ID, "channel", channel);

    expect(read?.maintenanceChannelIds).toEqual([]);

    // And the join table holds nothing, so no other path can read them
    // out of it either.
    const rows = await db
      .select()
      .from(lockdownMaintenanceChannels)
      .where(eq(lockdownMaintenanceChannels.lockdownId, record.id));

    expect(rows).toHaveLength(0);
  });
});

describe("maintenance on", () => {
  it("records the ids of the channels it created, and does not hide them", async () => {
    const calls: OverwriteCall[] = [];
    const chat = fakeChannel(channelId("on-chat"), "maintenance-chat", calls);
    const voice = fakeChannel(
      channelId("on-voice"),
      "maintenance-vc",
      calls,
    );
    const general = fakeChannel(channelId("on-general"), "general", calls);
    const guild = fakeGuild([chat, voice, general]);

    const result = await maintenanceOn({
      context: fakeContext(guild),
      role: everyoneRole(),
      maintenanceChannelIds: [chat.id, voice.id],
    });

    // Only the ordinary channel is hidden. The maintenance channels are
    // the one thing the role under maintenance keeps.
    expect(result.locked).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channelId).toBe(general.id);

    const record = await findLockdown(
      GUILD_ID,
      "maintenance",
      null,
      EVERYONE_ID,
    );

    expect(record?.maintenanceChannelIds).toEqual([chat.id, voice.id]);
    expect(record?.channelIds).toEqual([general.id]);
  });
});

describe("maintenance off", () => {
  it("deletes only the channels the lockdown recorded", async () => {
    const calls: OverwriteCall[] = [];
    const chat = fakeChannel(channelId("off-chat"), "maintenance-chat", calls);
    const voice = fakeChannel(
      channelId("off-voice"),
      "maintenance-vc",
      calls,
    );
    const hidden = fakeChannel(channelId("off-hidden"), "general", calls);

    // A moderator's own channel, with the name the bot uses.
    const moderators = fakeChannel(
      channelId("off-moderators"),
      "maintenance-chat",
      calls,
    );

    const guild = fakeGuild([chat, voice, hidden, moderators]);

    await makeMaintenanceLockdown({
      channelIds: [hidden.id],
      maintenanceChannelIds: [chat.id, voice.id],
    });

    const result = await maintenanceOff({
      context: fakeContext(guild),
      role: everyoneRole(),
    });

    expect(chat.deletions).toBe(1);
    expect(voice.deletions).toBe(1);

    // The moderator's channel is not the bot's to delete.
    expect(moderators.deletions).toBe(0);

    // The hidden channel is put back, not deleted.
    expect(hidden.deletions).toBe(0);

    expect(result.maintenanceChannels).toEqual({
      recorded: 2,
      deleted: 2,
      failed: 0,
      missing: 0,
    });
  });

  it("deletes nothing when the lockdown recorded no channels, and says so", async () => {
    const calls: OverwriteCall[] = [];
    const hidden = fakeChannel(channelId("empty-hidden"), "general", calls);
    const moderators = fakeChannel(
      channelId("empty-moderators"),
      "maintenance-chat",
      calls,
    );

    const guild = fakeGuild([hidden, moderators]);

    await makeMaintenanceLockdown({
      channelIds: [hidden.id],
      maintenanceChannelIds: [],
    });

    const result = await maintenanceOff({
      context: fakeContext(guild),
      role: everyoneRole(),
    });

    expect(result.maintenanceChannels.recorded).toBe(0);
    expect(result.maintenanceChannels.deleted).toBe(0);

    expect(moderators.deletions).toBe(0);
    expect(hidden.deletions).toBe(0);

    expect(describeMaintenanceChannels(result.maintenanceChannels)).toContain(
      "none were deleted",
    );
  });

  it("does not touch a lockdown of another type", async () => {
    const calls: OverwriteCall[] = [];
    const hidden = fakeChannel(channelId("other-hidden"), "general", calls);
    const chat = fakeChannel(channelId("other-chat"), "maintenance-chat", calls);
    const guild = fakeGuild([hidden, chat]);

    // A channel lockdown, and a maintenance lockdown for the same guild.
    const channelLock = await createLockdown({
      guildId: GUILD_ID,
      type: "channel",
      roleId: null,
      channelId: hidden.id,
      channelIds: [hidden.id],
      expireTime: null,
      authorId: MODERATOR_ID,
      priorState: {},
      sourceChannelId: null,
      maintenanceChannelIds: [],
    });

    if (!channelLock) throw new Error("The lockdown row was refused.");

    await makeMaintenanceLockdown({
      channelIds: [],
      maintenanceChannelIds: [],
    });

    await maintenanceOff({
      context: fakeContext(guild),
      role: everyoneRole(),
    });

    // The other lockdown is untouched: it is still there, and nothing was
    // changed or deleted on its behalf.
    const read = await findLockdown(GUILD_ID, "channel", hidden.id);

    expect(read?.id).toBe(channelLock.id);
    expect(hidden.deletions).toBe(0);
    expect(chat.deletions).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
