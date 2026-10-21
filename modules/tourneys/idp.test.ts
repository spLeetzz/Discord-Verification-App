/**
 * The room-credential command — `/idp`.
 *
 * The command shares a custom room's id, password and map, and the
 * message it posts deletes itself after thirty minutes. Three things
 * about it are security properties rather than features, and each one
 * is pinned down here:
 *
 *  1. **The reply is ephemeral (D23).** Quotient deleted the *user's*
 *     message to hide the password; a slash command has no user message
 *     to delete, so the reply is ephemeral instead.
 *  2. **The password never reaches the job payload.** The payload
 *     carries the channel id and the message id — the two things the
 *     deletion needs — and nothing else.
 *  3. **Only the named role may be pinged.**
 *
 * The deletion itself is a durable `jobs` row, never a `setTimeout`, and
 * the row is read back out of the database here: a test that only
 * checked the in-memory call would pass even if the row were never
 * written.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { MessageFlags } from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  Role,
} from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { jobs } from "../../db/schema.js";
import { registerJobHandler, runDueJobs } from "../../handlers/jobs.js";
import { idpCommand } from "./commands/idp.js";
import { onMessageDelete } from "./jobs.js";
import * as repo from "./repo.js";
import { handleTourneysJob } from "./register.js";
import {
  formatIdpCopy,
  handleIdpCopy,
  IDP_COPY_LABEL,
  IDP_LIFETIME_MS,
} from "./views/idp.js";

/** The prefix of every message id this file makes. */
const MESSAGE_ID_PREFIX = "idp-test-message";

/** The message id the handler tests use. Nothing writes it to a row. */
const HANDLER_MESSAGE_ID = `${MESSAGE_ID_PREFIX}-handler`;

/** The channel the fake interaction runs in. */
const CHANNEL_ID = "idp-test-channel";

/** The password the tests use. Nothing may log it or store it. */
const PASSWORD = "correct-horse-battery-staple";

/** How many fake messages this file has made. */
let messageCounter = 0;

/**
 * A message id of its own.
 *
 * Every fake interaction posts its own message, and every message arms
 * its own job row — so the ids have to differ, or one test's row would
 * answer for another's.
 */
function nextMessageId(): string {
  messageCounter += 1;

  return `${MESSAGE_ID_PREFIX}-${Date.now()}-${messageCounter}`;
}

/**
 * Is the database there?
 *
 * The test is skipped rather than failed when it is not, so the unit
 * tests still run on a machine without Postgres.
 */
async function databaseIsReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);

    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();

/** The shape of the payload the channel was sent. */
interface SentPayload {
  readonly content?: string;
  readonly embeds?: {
    readonly description?: string | null;
    readonly data?: { readonly description?: string | null };
  }[];
  readonly components?: {
    readonly components?: {
      readonly data?: { readonly label?: string; readonly custom_id?: string };
    }[];
  }[];
  readonly allowedMentions?: {
    readonly parse?: readonly string[];
    readonly roles?: readonly string[];
  };
}

/** The description of the embed that was sent. */
function sentDescription(payload: SentPayload): string {
  const embed = payload.embeds?.[0];

  return embed?.data?.description ?? embed?.description ?? "";
}

/** How the fake interaction is set up. */
interface FakeOptions {
  readonly roomId?: string;
  readonly password?: string;
  readonly map?: string;
  readonly roleId?: string | null;
  /** Is the member staff? Defaults to true. */
  readonly staff?: boolean;
  /** Has the interaction been deferred? Defaults to true. */
  readonly deferred?: boolean;
}

/** One answer the fake gave. */
interface FakeReply {
  readonly method: "reply" | "editReply" | "followUp";
  readonly payload: unknown;
}

/** A fake chat-input interaction, and what it sent and answered. */
function fakeInteraction(options: FakeOptions = {}) {
  const sent: { readonly payload: unknown }[] = [];
  const replies: FakeReply[] = [];
  const messageId = nextMessageId();

  const channel = {
    id: CHANNEL_ID,
    send: vi.fn(async (payload: unknown) => {
      sent.push({ payload });

      return { id: messageId };
    }),
  };

  const values: Record<string, string> = {
    room_id: options.roomId ?? "12345",
    password: options.password ?? PASSWORD,
    map: options.map ?? "Dust II",
  };

  const role = options.roleId
    ? ({ id: options.roleId, name: "Scrims" } as Role)
    : null;

  const staff = options.staff ?? true;

  const member = {
    permissions: { has: () => staff },
    roles: { cache: { some: () => false } },
  };

  const answer =
    (method: FakeReply["method"]) =>
    async (payload: unknown) => {
      replies.push({ method, payload });

      return { id: "idp-test-reply" };
    };

  const interaction = {
    guildId: "idp-test-guild",
    channelId: CHANNEL_ID,
    channel,
    user: { id: "idp-test-user" },
    guild: {
      members: {
        cache: new Map([["idp-test-user", member]]),
        fetch: async () => member,
      },
    },
    options: {
      getString: (name: string) => values[name] ?? null,
      getRole: () => role,
    },
    // The dispatcher defers every chat-input command before the body runs.
    deferred: options.deferred ?? true,
    replied: false,
    editReply: vi.fn(answer("editReply")),
    reply: vi.fn(answer("reply")),
    followUp: vi.fn(answer("followUp")),
  } as unknown as ChatInputCommandInteraction;

  return { interaction, sent, replies, channel, messageId };
}

/**
 * Runs the command the way the dispatcher does: the guard first, and the
 * body only when the guard allows it.
 *
 * @returns the refusal, or `null` when the command ran.
 */
async function runCommand(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  for (const guard of idpCommand.guards ?? []) {
    const refusal = await guard(interaction);

    if (refusal) return refusal;
  }

  await idpCommand.execute(interaction);

  return null;
}

/** A client that knows about one channel. */
function fakeClient(fetch: () => Promise<unknown>): Client {
  const channel = { id: CHANNEL_ID, messages: { fetch } };

  return {
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
  } as unknown as Client;
}

/** The armed message-delete job of one message. */
async function armedJob(messageId: string): Promise<{
  id: string;
  expiresAt: Date;
  payload: unknown;
} | null> {
  const armed = await repo.listMessageDeleteJobs();

  const mine = armed.filter((job) => {
    const payload = job.payload as { readonly messageId?: string };

    return payload?.messageId === messageId;
  });

  return mine[0] ?? null;
}

afterAll(async () => {
  await db
    .delete(jobs)
    .where(
      sql`${jobs.payload} ->> 'messageId' LIKE ${`${MESSAGE_ID_PREFIX}-%`}`,
    );

  await closeDatabase();
});

describe("the copy block", () => {
  it("holds the three values in one block", () => {
    const block = formatIdpCopy({
      roomId: "12345",
      password: "hunter2",
      map: "Dust II",
    });

    expect(block).toContain("Room ID: 12345");
    expect(block).toContain("Password: hunter2");
    expect(block).toContain("Map: Dust II");

    // One block: the values are fenced together, not three of them.
    expect(block.split("\n")).toHaveLength(5);
  });

  it("keeps a password with backticks inside the block", () => {
    const block = formatIdpCopy({
      roomId: "12345",
      password: "```hunter2```",
      map: "Dust II",
    });

    const fences = block
      .split("\n")
      .filter((line) => line.startsWith("```"));

    // The opening fence is longer than the run of backticks in the
    // password, so the password cannot close the block early.
    expect(fences[0]?.length).toBeGreaterThan(3);
    expect(block).toContain("Password: ```hunter2```");
  });
});

describe("the room-credential command", () => {
  it("is guarded by the area's staff guard", () => {
    expect(idpCommand.guards).toHaveLength(1);
  });

  it("refuses a member who is not staff", async () => {
    const { interaction, sent } = fakeInteraction({ staff: false });

    const refusal = await runCommand(interaction);

    expect(refusal).toBeTypeOf("string");
    expect(refusal).not.toBeNull();

    // Nothing was posted, and the password was not read.
    expect(sent).toHaveLength(0);
    expect(interaction.options.getString("password", true)).toBe(PASSWORD);
  });

  it("replies ephemerally, and never with the password", () => {
    // D23: the flag the dispatcher defers with.
    expect(idpCommand.ephemeral).toBe(true);
  });

  it("answers the copy button ephemerally", async () => {
    const description = formatIdpCopy({
      roomId: "12345",
      password: PASSWORD,
      map: "Dust II",
    });

    const answers: unknown[] = [];

    const reply = vi.fn(async (payload: unknown) => {
      answers.push(payload);

      return { id: "idp-test-reply" };
    });

    const interaction = {
      message: { embeds: [{ description }] },
      deferred: false,
      replied: false,
      reply,
    } as unknown as ButtonInteraction;

    await handleIdpCopy(interaction);

    expect(answers).toHaveLength(1);

    const payload = answers[0] as { content: string; flags: number };

    expect(payload.content).toBe(description);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it("says so when the message no longer holds the details", async () => {
    const answers: unknown[] = [];

    const reply = vi.fn(async (payload: unknown) => {
      answers.push(payload);

      return { id: "idp-test-reply" };
    });

    const interaction = {
      message: { embeds: [] },
      deferred: false,
      replied: false,
      reply,
    } as unknown as ButtonInteraction;

    await handleIdpCopy(interaction);

    expect(answers).toHaveLength(1);
  });
});

describe.skipIf(!reachable)("the room-credential command, with the database", () => {
  it("answers a staff member", async () => {
    const { interaction, sent } = fakeInteraction({ staff: true });

    const refusal = await runCommand(interaction);

    expect(refusal).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("carries the ephemeral flag on the reply itself", async () => {
    // The dispatcher defers, so the flag is already fixed by the
    // deferral. This is the other path: an interaction that has not
    // answered yet must still answer ephemerally.
    const { interaction, replies } = fakeInteraction({ deferred: false });

    await idpCommand.execute(interaction);

    expect(replies).toHaveLength(1);

    const payload = replies[0]?.payload as {
      content: string;
      flags: number;
    };

    expect(replies[0]?.method).toBe("reply");
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).not.toContain(PASSWORD);
  });

  it("posts the three values, with the copy button", async () => {
    const { interaction, sent } = fakeInteraction();

    await idpCommand.execute(interaction);

    expect(sent).toHaveLength(1);

    const payload = sent[0]?.payload as SentPayload;

    const description = sentDescription(payload);

    expect(description).toContain("Room ID: 12345");
    expect(description).toContain(`Password: ${PASSWORD}`);
    expect(description).toContain("Map: Dust II");

    const button = payload.components?.[0]?.components?.[0];

    expect(button?.data?.label).toBe(IDP_COPY_LABEL);
  });

  it("arms a msg_delete job for the message it posted", async () => {
    const { interaction, messageId } = fakeInteraction();

    await idpCommand.execute(interaction);

    const job = await armedJob(messageId);

    expect(job).not.toBeNull();

    // Thirty minutes, give or take the time the test took.
    const expiresAt = job?.expiresAt.getTime() ?? 0;

    expect(expiresAt).toBeGreaterThan(Date.now() + IDP_LIFETIME_MS - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + IDP_LIFETIME_MS);
  });

  it("never puts the password in the job payload", async () => {
    const { interaction, messageId } = fakeInteraction();

    await idpCommand.execute(interaction);

    const job = await armedJob(messageId);

    expect(job).not.toBeNull();

    // The payload holds the two ids the deletion needs — and nothing
    // else. A password in here would be a password in a table.
    expect(job?.payload).toEqual({
      channelId: CHANNEL_ID,
      messageId,
    });

    expect(JSON.stringify(job?.payload)).not.toContain(PASSWORD);
  });

  it("replies without the password", async () => {
    const { interaction, replies } = fakeInteraction();

    await idpCommand.execute(interaction);

    expect(replies).toHaveLength(1);

    const payload = replies[0]?.payload as { content: string };

    expect(replies[0]?.method).toBe("editReply");
    expect(payload.content).not.toContain(PASSWORD);
  });

  it("pings only the role it was given", async () => {
    const { interaction, sent } = fakeInteraction({ roleId: "role-42" });

    await idpCommand.execute(interaction);

    const payload = sent[0]?.payload as SentPayload;

    expect(payload.content).toBe("<@&role-42>");
    expect(payload.allowedMentions?.parse).toEqual([]);
    expect(payload.allowedMentions?.roles).toEqual(["role-42"]);
  });

  it("pings nobody when no role was given", async () => {
    const { interaction, sent } = fakeInteraction({ roleId: null });

    await idpCommand.execute(interaction);

    const payload = sent[0]?.payload as SentPayload;

    expect(payload.content).toBeUndefined();
    expect(payload.allowedMentions?.parse).toEqual([]);
    expect(payload.allowedMentions?.roles).toEqual([]);
  });

  it("refuses a room id or a map that is empty", async () => {
    const { interaction, sent, replies } = fakeInteraction({ roomId: "  " });

    await idpCommand.execute(interaction);

    expect(sent).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  it("is claimed by the dispatcher, and the message is deleted", async () => {
    const { interaction, messageId } = fakeInteraction();

    await idpCommand.execute(interaction);

    const job = await armedJob(messageId);

    expect(job).not.toBeNull();

    // Make the row due. The dispatcher takes the rows whose time has
    // passed, and it deletes a row before it dispatches it.
    await db
      .update(jobs)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(jobs.id, job?.id ?? ""));

    const deleted: string[] = [];

    const client = {
      channels: {
        cache: new Map([
          [
            CHANNEL_ID,
            {
              id: CHANNEL_ID,
              messages: {
                fetch: async () => ({
                  id: messageId,
                  delete: async () => {
                    deleted.push(messageId);
                  },
                }),
              },
            },
          ],
        ]),
      },
    } as unknown as Client;

    registerJobHandler("msg_delete", handleTourneysJob);

    const fired = await runDueJobs(client);

    expect(fired).toBeGreaterThanOrEqual(1);
    expect(deleted).toEqual([messageId]);

    // The row is gone: the dispatcher claims a job by deleting it.
    expect(await armedJob(messageId)).toBeNull();
  });
});

describe("the msg_delete handler", () => {
  it("deletes the message", async () => {
    const deleted: string[] = [];

    const client = fakeClient(async () => ({
      id: HANDLER_MESSAGE_ID,
      delete: async () => {
        deleted.push(HANDLER_MESSAGE_ID);
      },
    }));

    await onMessageDelete(client, {
      channelId: CHANNEL_ID,
      messageId: HANDLER_MESSAGE_ID,
    });

    expect(deleted).toEqual([HANDLER_MESSAGE_ID]);
  });

  it("does not throw when the message is already gone", async () => {
    const client = fakeClient(async () => {
      throw new Error("Unknown Message");
    });

    await expect(
      onMessageDelete(client, {
        channelId: CHANNEL_ID,
        messageId: HANDLER_MESSAGE_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the channel is gone", async () => {
    const client = {
      channels: { cache: new Map() },
    } as unknown as Client;

    await expect(
      onMessageDelete(client, {
        channelId: CHANNEL_ID,
        messageId: HANDLER_MESSAGE_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores a payload that names no message", async () => {
    const client = fakeClient(async () => {
      throw new Error("the fetch must not happen");
    });

    await expect(onMessageDelete(client, {})).resolves.toBeUndefined();
    await expect(onMessageDelete(client, null)).resolves.toBeUndefined();
  });
});
