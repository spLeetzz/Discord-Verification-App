/**
 * The ban log.
 *
 * The slot area owns the published slot list, so it owns the **Punish**
 * button on it — and a ban made through that button has to leave the
 * same trail a ban made anywhere else leaves. These are the promises of
 * that trail:
 *
 *  - a punish writes one entry per ban;
 *  - an unban writes one entry per unban;
 *  - a write that fails does not fail the ban;
 *  - the entry carries the channel, the reason and the moderator.
 *
 * The database is the live one: the `ban_logs` row, the `banned_teams`
 * row and the scrim are what the flow reads. Discord is a fake — the bot
 * must never talk to Discord in a test.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ChannelType, Collection } from "discord.js";
import type { Client, EmbedBuilder, Guild, TextChannel } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { banLogs, bannedTeams, jobs, scrims, slots } from "../../db/schema.js";
import { discordTimestamp } from "../../core/time.js";
import { handleSlotsJob } from "./jobs.js";
import { BanMode } from "./types.js";
import { punishSlots, unbanSlots } from "./views/slotlist.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `slots-banlog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The channel the ban log goes to. */
const CHANNEL_ID = "900000000000000201";

/** The moderator who does the banning. */
const MODERATOR = "900000000000000202";

/** The captain of the banned team. */
const CAPTAIN = "900000000000000203";

/** The second member of the banned team. */
const SECOND = "900000000000000204";

/** The name of the scrim the fixtures live on. */
const SCRIM_NAME = "Ban log test scrim";

/** The scrim the fixtures live on. */
let scrimId = "";

/** The slot the fixtures live on. */
let slotId = "";

/** What a channel recorded. */
interface Sent {
  readonly embeds: readonly EmbedBuilder[];
}

/**
 * A channel that records what was sent to it.
 *
 * @param fail when set, every send throws — the channel that was
 *             deleted, or the permission that was taken away.
 */
function makeChannel(fail = false): {
  readonly channel: TextChannel;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];

  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    send: async (payload: Sent) => {
      if (fail) throw new Error("The channel is not available any more");

      sent.push(payload);

      return { id: "sent-1" };
    },
  } as unknown as TextChannel;

  return { channel, sent };
}

/** A guild that holds the ban log channel. */
function makeGuild(channel: TextChannel): Guild {
  return {
    id: GUILD_ID,
    channels: {
      cache: new Collection<string, TextChannel>([[CHANNEL_ID, channel]]),
    },
  } as unknown as Guild;
}

/** A client whose guild holds the ban log channel. */
function makeClient(guild: Guild): Client {
  return {
    guilds: { cache: new Collection<string, Guild>([[GUILD_ID, guild]]) },
  } as unknown as Client;
}

/** The value of a field of an embed. */
function field(embed: EmbedBuilder | undefined, name: string): string | undefined {
  return embed?.data.fields?.find((entry) => entry.name === name)?.value;
}

/** Creates the fixture scrim, its slot and the ban log row. */
async function seed(): Promise<void> {
  const rows = await db
    .insert(scrims)
    .values({
      guildId: GUILD_ID,
      name: SCRIM_NAME,
      status: "closed",
      registrationChannelId: "900000000000000205",
      slotlistChannelId: "900000000000000206",
      roleId: "900000000000000207",
      openTime: new Date(),
      totalSlots: 1,
      startFrom: 1,
      hostId: "900000000000000208",
      closedAt: new Date(),
      matchTime: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: scrims.id });

  scrimId = rows[0]?.id ?? "";

  const slotRows = await db
    .insert(slots)
    .values({
      scrimId,
      num: 1,
      state: "claimed",
      teamName: "Team Alpha",
      ownerUserId: CAPTAIN,
      members: [CAPTAIN, SECOND],
    })
    .returning({ id: slots.id });

  slotId = slotRows[0]?.id ?? "";

  await db.insert(banLogs).values({ guildId: GUILD_ID, channelId: CHANNEL_ID });
}

/** Removes every fixture. */
async function clean(): Promise<void> {
  if (!scrimId) return;

  await db.delete(slots).where(eq(slots.scrimId, scrimId));
  await db.delete(bannedTeams).where(eq(bannedTeams.scrimId, scrimId));
  await db
    .delete(jobs)
    .where(sql`${jobs.payload}::text like ${`%${scrimId}%`}`);
  await db.delete(scrims).where(eq(scrims.id, scrimId));
  await db.delete(banLogs).where(eq(banLogs.guildId, GUILD_ID));
}

/** The bans of the fixture scrim. */
async function bans(): Promise<{ userId: string; reason: string | null }[]> {
  const rows = await db
    .select({ userId: bannedTeams.userId, reason: bannedTeams.reason })
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId));

  return rows;
}

beforeEach(async () => {
  await clean();
  await seed();
});

afterAll(async () => {
  await clean();

  await db.delete(banLogs).where(eq(banLogs.guildId, GUILD_ID));

  await closeDatabase();
});

describe("the punish flow", () => {
  it("writes a ban log entry", async () => {
    const fake = makeChannel();
    const guild = makeGuild(fake.channel);

    const outcome = await punishSlots({
      scrimId,
      slotIds: [slotId],
      mode: BanMode.leaderThisScrim,
      reason: "Team rage",
      expires: null,
      moderatorId: MODERATOR,
      guild,
    });

    expect(outcome).toBe("Banned 1 player from 1 scrim.");
    expect(fake.sent).toHaveLength(1);

    const embed = fake.sent[0]?.embeds[0];

    expect(embed?.data.title).toBe("🔨 Banned");
    expect(field(embed, "User")).toBe(`<@${CAPTAIN}>`);
    expect(field(embed, "Scrim")).toBe(SCRIM_NAME);
    expect(field(embed, "Reason")).toBe("Team rage");
    expect(field(embed, "Moderator")).toBe(`<@${MODERATOR}>`);
    expect(field(embed, "Until")).toBe("Never expires");
  });

  it("writes the ban down", async () => {
    const fake = makeChannel();

    await punishSlots({
      scrimId,
      slotIds: [slotId],
      mode: BanMode.leaderThisScrim,
      reason: "Team rage",
      expires: null,
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(await bans()).toEqual([{ userId: CAPTAIN, reason: "Team rage" }]);
  });

  it("writes one entry per ban, and says when the ban runs out", async () => {
    const fake = makeChannel();

    const expires = new Date(Date.now() + 86_400_000);

    await punishSlots({
      scrimId,
      slotIds: [slotId],
      mode: BanMode.teamThisScrim,
      reason: "Team rage",
      expires,
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    // The whole team was banned, so there are two bans and two entries.
    expect(fake.sent).toHaveLength(2);

    const users = fake.sent.map((entry) => field(entry.embeds[0], "User"));

    expect(users).toEqual([`<@${CAPTAIN}>`, `<@${SECOND}>`]);

    for (const entry of fake.sent) {
      expect(field(entry.embeds[0], "Until")).toBe(discordTimestamp(expires, "f"));
    }
  });

  it("does not fail the ban when the log cannot be written", async () => {
    const fake = makeChannel(true);

    const outcome = await punishSlots({
      scrimId,
      slotIds: [slotId],
      mode: BanMode.leaderThisScrim,
      reason: "Team rage",
      expires: null,
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(outcome).toBe("Banned 1 player from 1 scrim.");

    // The ban is in the database, even though the log could not be
    // written. A ban that is applied but not logged is recoverable; a
    // ban that is refused because a log write failed is not.
    expect(await bans()).toEqual([{ userId: CAPTAIN, reason: "Team rage" }]);
  });

  it("does not fail the ban when the guild has no ban log channel", async () => {
    const fake = makeChannel();

    await db.delete(banLogs).where(eq(banLogs.guildId, GUILD_ID));

    const outcome = await punishSlots({
      scrimId,
      slotIds: [slotId],
      mode: BanMode.leaderThisScrim,
      reason: "Team rage",
      expires: null,
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(outcome).toBe("Banned 1 player from 1 scrim.");
    expect(fake.sent).toHaveLength(0);
    expect(await bans()).toHaveLength(1);
  });
});

describe("the unban flow", () => {
  it("writes an unban entry", async () => {
    const fake = makeChannel();

    await db.insert(bannedTeams).values({
      scrimId,
      userId: CAPTAIN,
      reason: "Team rage",
      expires: null,
    });

    const outcome = await unbanSlots({
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(outcome).toBe("Unbanned 1 player from 1 scrim.");
    expect(fake.sent).toHaveLength(1);

    const embed = fake.sent[0]?.embeds[0];

    expect(embed?.data.title).toBe("🔓 Unbanned");
    expect(field(embed, "User")).toBe(`<@${CAPTAIN}>`);
    expect(field(embed, "Scrim")).toBe(SCRIM_NAME);
    expect(field(embed, "Reason")).toBe("Team rage");
    expect(field(embed, "Moderator")).toBe(`<@${MODERATOR}>`);
  });

  it("lifts the ban", async () => {
    const fake = makeChannel();

    await db.insert(bannedTeams).values({
      scrimId,
      userId: CAPTAIN,
      reason: "Team rage",
      expires: null,
    });

    await unbanSlots({
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(await bans()).toHaveLength(0);
  });

  it("says nothing about a member who was not banned", async () => {
    const fake = makeChannel();

    const outcome = await unbanSlots({
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(outcome).toBe("Nobody was unbanned.");
    expect(fake.sent).toHaveLength(0);
  });

  it("does not fail the unban when the log cannot be written", async () => {
    const fake = makeChannel(true);

    await db.insert(bannedTeams).values({
      scrimId,
      userId: CAPTAIN,
      reason: "Team rage",
      expires: null,
    });

    const outcome = await unbanSlots({
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
      moderatorId: MODERATOR,
      guild: makeGuild(fake.channel),
    });

    expect(outcome).toBe("Unbanned 1 player from 1 scrim.");
    expect(await bans()).toHaveLength(0);
  });
});

describe("the ban that ran out", () => {
  it("writes an unban entry and lifts the ban", async () => {
    const fake = makeChannel();
    const guild = makeGuild(fake.channel);

    await db.insert(bannedTeams).values({
      scrimId,
      userId: CAPTAIN,
      reason: "Team rage",
      expires: new Date(Date.now() - 1_000),
    });

    await handleSlotsJob(makeClient(guild), "scrim_ban", {
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
    });

    expect(await bans()).toHaveLength(0);
    expect(fake.sent).toHaveLength(1);

    const embed = fake.sent[0]?.embeds[0];

    expect(embed?.data.title).toBe("🔓 Unbanned");
    expect(field(embed, "User")).toBe(`<@${CAPTAIN}>`);
    expect(field(embed, "Scrim")).toBe(SCRIM_NAME);

    // The bot lifted the ban, so there is no moderator to name.
    expect(field(embed, "Moderator")).toBeUndefined();
  });

  it("reads the payload the scrims area writes, without doubling the entry", async () => {
    const fake = makeChannel();
    const guild = makeGuild(fake.channel);

    await db.insert(bannedTeams).values({
      scrimId,
      userId: CAPTAIN,
      reason: "Team rage",
      expires: new Date(Date.now() - 1_000),
    });

    // The scrims area's payload names the scrim twice: once on its own
    // and once in the list. The ban is lifted once and leaves one entry.
    await handleSlotsJob(makeClient(guild), "scrim_ban", {
      scrimId,
      scrimIds: [scrimId],
      userIds: [CAPTAIN],
      reason: "Team rage",
    });

    expect(await bans()).toHaveLength(0);
    expect(fake.sent).toHaveLength(1);
  });

  it("ignores a payload that names nothing", async () => {
    const fake = makeChannel();
    const guild = makeGuild(fake.channel);

    await handleSlotsJob(makeClient(guild), "scrim_ban", {});

    expect(fake.sent).toHaveLength(0);
  });
});
