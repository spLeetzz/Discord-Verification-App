/**
 * The bot must not notify anybody on a member's say-so.
 *
 * A tag's body is stored verbatim and posted as message **content**, so
 * a member could store `@everyone` in a tag and then have the bot —
 * which holds "Mention Everyone" — ping the whole server. The member
 * would be using a permission they do not have, and the bot would be
 * holding it for them.
 *
 * `/tag raw` escaped its body; `/tag show` did not, and the two paths
 * are the same data. The reminder's own text comes back out in the
 * confirmation, so it has the same problem.
 *
 * These tests drive the commands with a fake interaction and read the
 * payload that was sent, so they check the two things that matter:
 *
 *  - the reply allows no mentions at all (`allowed_mentions.parse` is
 *    empty), so Discord is told not to parse a mention out of it;
 *  - the body that is posted is escaped, so it is not a mention even if
 *    the first one is missing.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { TagRecord } from "./types.js";

/**
 * What the mocked service hands back.
 *
 * `vi.hoisted` runs before the mock factory, so the factory may close
 * over it.
 */
const state = vi.hoisted(() => ({
  tag: null as TagRecord | null,
}));

/**
 * The service is mocked rather than used, so the test needs no database
 * and no environment.
 */
vi.mock("./service.js", () => ({
  findTag: vi.fn(async () => state.tag),
  countTagUse: vi.fn(async () => undefined),
  createTag: vi.fn(async () => {
    throw new Error("not used in this test");
  }),
  deleteTag: vi.fn(async () => state.tag),
  createReminder: vi.fn(async () => "reminder-id"),
  countReminders: vi.fn(async () => 0),
  listReminders: vi.fn(async () => []),
  deleteReminder: vi.fn(async () => true),
  deleteReminders: vi.fn(async () => 0),
}));

/** The repository is mocked for the same reason. */
vi.mock("./repo.js", () => ({
  listTagsMatching: vi.fn(async () => []),
}));

/** The payload a reply carried. */
interface SentPayload {
  content?: string;
  allowedMentions?: {
    parse?: readonly string[];
    users?: readonly string[];
    roles?: readonly string[];
  };
  embeds?: unknown[];
}

/** The fake interaction and the payloads it was sent. */
interface FakeCommand {
  interaction: ChatInputCommandInteraction;
  sent: SentPayload[];
}

/**
 * Builds a chat-input interaction the commands can run against.
 *
 * The dispatcher defers every command before the body runs, so the fake
 * starts out deferred and the reply lands in `editReply`.
 */
function fakeCommand(options: {
  subcommand: string;
  strings?: Record<string, string | null>;
  booleans?: Record<string, boolean | null>;
  users?: Record<string, { id: string; username: string } | null>;
  userId?: string;
}): FakeCommand {
  const sent: SentPayload[] = [];

  const handle = {
    awaitMessageComponent: vi.fn(),
    edit: vi.fn(),
  };

  const record = async (payload: SentPayload) => {
    sent.push(payload);

    return handle;
  };

  const userId = options.userId ?? "111111111111111111";

  const interaction = {
    deferred: true,
    replied: false,
    user: { id: userId, username: "member" },
    guildId: "guild-1",
    guild: {
      id: "guild-1",
      members: {
        cache: new Map(),
        me: null,
        fetch: async () => null,
      },
      channels: { cache: new Map() },
    },
    channelId: "channel-1",
    channel: { nsfw: false },
    options: {
      getSubcommand: () => options.subcommand,
      getString: (name: string) => options.strings?.[name] ?? null,
      getBoolean: (name: string) => options.booleans?.[name] ?? null,
      getUser: (name: string) => options.users?.[name] ?? null,
      getChannel: () => null,
    },
    reply: record,
    editReply: record,
    followUp: record,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, sent };
}

/** A tag that says something the bot must not repeat as a mention. */
function tagWithBody(content: string): TagRecord {
  return {
    id: "33333333333333333333333333333333",
    guildId: "guild-1",
    name: "ping",
    content,
    isEmbed: false,
    isNsfw: false,
    ownerId: "222222222222222222",
    usage: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("a tag whose body is a mention", () => {
  it("does not notify when it is shown", async () => {
    const { default: tagCommand } = await import("./commands/tag.js");

    state.tag = tagWithBody("Hey @everyone, welcome to the server!");

    const fake = fakeCommand({
      subcommand: "show",
      strings: { name: "ping" },
    });

    await tagCommand.execute(fake.interaction);

    expect(fake.sent).toHaveLength(1);

    const payload = fake.sent[0];

    // The reply itself allows nothing to be parsed out of it.
    expect(payload?.allowedMentions?.parse).toEqual([]);

    // And the body is escaped, so it is not a mention at all.
    expect(payload?.content).toBe("Hey @\u200beveryone, welcome to the server!");
    expect(payload?.content).not.toContain("@everyone");
  });

  it("does not notify for a user mention either", async () => {
    const { default: tagCommand } = await import("./commands/tag.js");

    state.tag = tagWithBody("ping <@123456789012345678> now");

    const fake = fakeCommand({
      subcommand: "show",
      strings: { name: "ping" },
    });

    await tagCommand.execute(fake.interaction);

    const payload = fake.sent[0];

    expect(payload?.allowedMentions?.parse).toEqual([]);
    expect(payload?.content).not.toContain("<@123456789012345678>");
  });

  it("keeps the tag's own markdown", async () => {
    const { default: tagCommand } = await import("./commands/tag.js");

    state.tag = tagWithBody("**rules**: be nice");

    const fake = fakeCommand({
      subcommand: "show",
      strings: { name: "ping" },
    });

    await tagCommand.execute(fake.interaction);

    // Only the mentions are escaped: a tag is a canned message and its
    // formatting is the point of it.
    expect(fake.sent[0]?.content).toBe("**rules**: be nice");
  });

  it("does not notify through the tag's name", async () => {
    const { default: tagCommand } = await import("./commands/tag.js");

    state.tag = tagWithBody("Something.");

    const fake = fakeCommand({
      subcommand: "delete",
      strings: { name: "ping" },
      // The caller owns the tag, so the delete goes through.
      userId: "222222222222222222",
    });

    await tagCommand.execute(fake.interaction);

    // The name is in the confirmation, and the name is the caller's own
    // text: a tag called `@everyone` must not ping the server.
    expect(fake.sent[0]?.allowedMentions?.parse).toEqual([]);
    expect(fake.sent[0]?.content).not.toContain("@everyone");
  });
});

describe("a reminder whose text is a mention", () => {
  it("does not notify", async () => {
    const { default: reminderCommand } = await import("./commands/reminder.js");

    const fake = fakeCommand({
      subcommand: "set",
      strings: { when: "2d", text: "@everyone meet in the lobby" },
    });

    await reminderCommand.execute(fake.interaction);

    const payload = fake.sent[0];

    expect(payload?.allowedMentions?.parse).toEqual([]);
    expect(payload?.content).toContain("@\u200beveryone");
    expect(payload?.content).not.toContain("@everyone");
  });

  it("mentions only the member the reminder is for when it is delivered", async () => {
    const { deliverReminder } = await import("./views/reminder.js");

    const sent: SentPayload[] = [];

    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      isTextBased: () => true,
      isDMBased: () => false,
      isSendable: () => true,
      send: async (payload: SentPayload) => {
        sent.push(payload);

        return {};
      },
    };

    const client = {
      channels: { cache: new Map([["channel-1", channel]]), fetch: vi.fn() },
    } as unknown as Client;

    const result = await deliverReminder(
      client,
      {
        channelId: "channel-1",
        userId: "111111111111111111",
        message: "@everyone meet in the lobby",
        reminderId: "reminder-id",
      },
      { reminderId: "reminder-id", createdAt: new Date() },
    );

    expect(result).toBe("delivered");

    const payload = sent[0];

    expect(payload?.allowedMentions?.parse).toEqual([]);
    expect(payload?.allowedMentions?.users).toEqual(["111111111111111111"]);
  });
});
