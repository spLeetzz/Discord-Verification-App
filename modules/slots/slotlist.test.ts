/**
 * The published slot list's public API.
 *
 * The scrims area publishes the slot list when a scrim closes, and it
 * does it through this API. The three things the API promises are
 * proved here:
 *
 *  - **one panel.** The message carries the slot area's buttons, and
 *    their custom ids are the slot area's own — `slots:slotlist_*`.
 *  - **one writer.** The publisher records the message id on the scrim
 *    row, so the message is found again after a restart.
 *  - **nothing to publish is not an error.** A scrim with no team in it
 *    has no slot list to publish, and the API says so with `null`.
 *
 * The Discord side is a fake: the API only needs a channel to send to
 * and a message to re-render. The database is the live one, because the
 * message id has to survive a round trip through the row.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Collection } from "discord.js";
import { ChannelType } from "discord.js";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  EmbedBuilder,
  Guild,
  Message,
  TextChannel,
} from "discord.js";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { scrims, slots } from "../../db/schema.js";
import { setSlotsClient } from "./client.js";
import { claimSlot, getScrim } from "./repo.js";
import {
  buildSlotListPanel,
  publishSlotList,
  refreshSlotListMessage,
} from "./slotlist.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `slots-slotlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The channel the fake bot publishes into. */
const CHANNEL_ID = "900000000000000101";

/** The owner of the claimed slot. */
const OWNER = "111111111111111111";

/** The scrim the fixtures live on. */
let scrimId = "";

/** What the fake channel recorded. */
interface Recorded {
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
}

/** The fake channel, and what it recorded. */
interface FakeChannel {
  readonly channel: TextChannel;
  readonly sent: Recorded[];
  readonly edits: Recorded[];
}

/**
 * A message that records what was edited on it.
 *
 * @param id    the message's id;
 * @param edits where the edits are recorded.
 */
function makeMessage(id: string, edits: Recorded[]): Message {
  const message = {
    id,
    edit: async (payload: Recorded) => {
      edits.push(payload);
      return message;
    },
  } as unknown as Message;

  return message;
}

/**
 * A channel that records what was sent to it and what was edited on it.
 *
 * A message that was sent can be fetched again, the way a real channel
 * behaves — that is what makes a refresh find the message it published.
 *
 * @param messageId the id of the message that is already in the channel.
 */
function makeChannel(messageId: string | null): FakeChannel {
  const sent: Recorded[] = [];
  const edits: Recorded[] = [];
  const messages = new Map<string, Message>();

  if (messageId) {
    messages.set(messageId, makeMessage(messageId, edits));
  }

  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    send: async (payload: Recorded) => {
      sent.push(payload);

      const id = `sent-${sent.length}`;

      messages.set(id, makeMessage(id, edits));

      return { id };
    },
    messages: {
      fetch: async (id: string) => messages.get(id) ?? null,
    },
  } as unknown as TextChannel;

  return { channel, sent, edits };
}

/** A client whose guild holds one channel. */
function makeClient(channel: TextChannel): Client {
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Collection<string, TextChannel>([[CHANNEL_ID, channel]]),
      fetch: async () =>
        new Collection<string, TextChannel>([[CHANNEL_ID, channel]]),
    },
  } as unknown as Guild;

  return {
    guilds: { cache: new Collection<string, Guild>([[GUILD_ID, guild]]) },
    channels: {
      cache: new Collection<string, TextChannel>(),
      fetch: async (id: string) =>
        id === CHANNEL_ID ? channel : null,
    },
  } as unknown as Client;
}

/** Creates the fixture scrim and its two slots. */
async function seed(): Promise<void> {
  const rows = await db
    .insert(scrims)
    .values({
      guildId: GUILD_ID,
      name: "Slot list test scrim",
      status: "closed",
      registrationChannelId: "900000000000000102",
      slotlistChannelId: CHANNEL_ID,
      roleId: "900000000000000103",
      openTime: new Date(),
      totalSlots: 2,
      startFrom: 1,
      hostId: "900000000000000104",
      closedAt: new Date(),
      matchTime: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: scrims.id });

  scrimId = rows[0]?.id ?? "";

  await db.insert(slots).values([
    { scrimId, num: 1 },
    { scrimId, num: 2 },
  ]);
}

/** Removes every fixture. */
async function clean(): Promise<void> {
  if (!scrimId) return;

  await db.delete(slots).where(eq(slots.scrimId, scrimId));
  await db.delete(scrims).where(eq(scrims.id, scrimId));
}

beforeEach(async () => {
  await clean();
  await seed();
});

afterAll(async () => {
  await clean();
  await db.delete(scrims).where(eq(scrims.guildId, GUILD_ID));

  await closeDatabase();
});

describe("the published slot list", () => {
  it("is published with the slot area's own panel", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const messageId = await publishSlotList(scrimId);

    expect(messageId).toBe("sent-1");
    expect(fake.sent).toHaveLength(1);

    const ids = (fake.sent[0]?.components ?? [])
      .flatMap((row) => row.components)
      .map((component) => (component as { data: { custom_id: string } }).data.custom_id);

    expect(ids).toEqual([
      `slots:slotlist_edit:${scrimId}`,
      `slots:slotlist_punish:${scrimId}`,
      `slots:slotlist_info:${scrimId}`,
    ]);
  });

  it("records the message on the scrim row, so it survives a restart", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const messageId = await publishSlotList(scrimId);

    const rows = await db
      .select({ id: scrims.slotlistMessageId })
      .from(scrims)
      .where(eq(scrims.id, scrimId));

    expect(rows[0]?.id).toBe(messageId);
  });

  it("has nothing to publish when no team has claimed a slot", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    const messageId = await publishSlotList(scrimId);

    expect(messageId).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  it("has nothing to publish when the scrim does not exist", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    const messageId = await publishSlotList("00000000-0000-0000-0000-000000000000");

    expect(messageId).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  it("re-renders the published message rather than sending a second one", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    await publishSlotList(scrimId);

    // The message is in the channel now, under the id that was recorded.
    const published = await getScrim(scrimId);

    expect(published?.slotlistMessageId).toBe("sent-1");

    const second = await publishSlotList(scrimId);

    expect(second).toBe("sent-1");
    expect(fake.sent).toHaveLength(1);
    expect(fake.edits).toHaveLength(1);
  });
});

describe("the refresh", () => {
  it("re-renders the message the row points at", async () => {
    const fake = makeChannel("message-published");

    setSlotsClient(makeClient(fake.channel));

    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    await db
      .update(scrims)
      .set({ slotlistMessageId: "message-published" })
      .where(eq(scrims.id, scrimId));

    await refreshSlotListMessage("message-published");

    expect(fake.edits).toHaveLength(1);

    const ids = (fake.edits[0]?.components ?? [])
      .flatMap((row) => row.components)
      .map((component) => (component as { data: { custom_id: string } }).data.custom_id);

    expect(ids).toEqual([
      `slots:slotlist_edit:${scrimId}`,
      `slots:slotlist_punish:${scrimId}`,
      `slots:slotlist_info:${scrimId}`,
    ]);
  });

  it("says nothing when the message is not there any more", async () => {
    const fake = makeChannel(null);

    setSlotsClient(makeClient(fake.channel));

    await db
      .update(scrims)
      .set({ slotlistMessageId: "message-gone" })
      .where(eq(scrims.id, scrimId));

    await refreshSlotListMessage("message-gone");

    expect(fake.edits).toHaveLength(0);
  });
});

describe("the panel", () => {
  it("carries the scrim's id on every button", () => {
    const ids = buildSlotListPanel("scrim-42")
      .flatMap((row) => row.components)
      .map((component) => (component as { data: { custom_id: string } }).data.custom_id);

    expect(ids).toEqual([
      "slots:slotlist_edit:scrim-42",
      "slots:slotlist_punish:scrim-42",
      "slots:slotlist_info:scrim-42",
    ]);
  });
});
