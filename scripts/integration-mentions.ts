/**
 * Integration check for the "captain mentions his players" flow.
 *
 * Uses the real Discord client and the real handler. The only thing faked is
 * the message author, because the bot cannot post as a human — Discord
 * delivers a message from the bot itself as author.bot === true, which the
 * handler deliberately ignores.
 *
 * Run with: npx tsx scripts/integration-mentions.ts <captain-id> <player-id>
 */

import "dotenv/config";
import { Client, Events, GatewayIntentBits, ChannelType } from "discord.js";
import type { Message } from "discord.js";
import { handleMessage } from "../handlers/messages.js";
import { logger } from "../utils/logger.js";

const CAPTAIN_ID = process.argv[2];
const TARGET_ID = process.argv[3];

if (!CAPTAIN_ID || !TARGET_ID) {
  console.error("usage: tsx scripts/integration-mentions.ts <captain-id> <player-id>");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on(Events.Error, (e) => logger.error("client error", e));

await client.login(process.env.BSSA_DISCORD_BOT_TOKEN!);

const guild = await client.guilds.fetch(process.env.ALLOWED_GUILD_ID!);
const channel = await guild.channels.fetch(process.env.FREE_FIRE_CHANNEL_ID!);

if (!channel || channel.type !== ChannelType.GuildText) {
  console.error("verification channel not found");
  process.exit(1);
}

const captainUser = await client.users.fetch(CAPTAIN_ID);
const targetUser = await client.users.fetch(TARGET_ID);

// 1. create a private ticket thread, exactly like the bot does
const thread = await channel.threads.create({
  name: "zz-integration-test",
  type: ChannelType.PrivateThread,
  invitable: false,
});

console.log("thread created:", thread.id);
console.log("captain:", captainUser.username, "| player:", targetUser.username);

// 2. a message that mentions the player
const posted = await thread.send(`IGN 1: TestPlayer  UID 1: 123456789 <@${TARGET_ID}>`);

console.log("mentions parsed by discord.js:", [...posted.mentions.users.keys()]);

/**
 * A stand-in for a message written by the captain.
 *
 * It cannot be the real Message object: discord.js re-patches a cached
 * message's `author` whenever the message store is refreshed, which would
 * silently turn the fake captain back into the bot.
 */
const captainMessage = {
  author: captainUser,
  channel: thread,
  mentions: posted.mentions,
} as unknown as Message;

// 3. Discord auto-adds users who are mentioned in a private thread, so drop
//    the player again to exercise the handler's own add path.
await thread.members.remove(TARGET_ID);

const before = await thread.members.fetch();
console.log("thread members before handler:", [...before.keys()]);

await handleMessage(captainMessage);

const after = await thread.members.fetch();
console.log("thread members after handler: ", [...after.keys()]);

const added = after.has(TARGET_ID);
console.log(
  added
    ? "PASS: the handler added the mentioned player to the private thread"
    : "FAIL: the handler did not add the mentioned player",
);

// 4. the bot posts a join notice so the player knows why they can see it
const messages = await thread.messages.fetch({ limit: 10 });
const notice = [...messages.values()].find((m) =>
  m.content.includes("been added to this ticket"),
);
console.log(
  notice ? `PASS: join notice posted — "${notice.content}"` : "FAIL: no join notice",
);

// 5. running the handler again must not add anyone twice
await handleMessage(captainMessage);
const again = await thread.members.fetch();
console.log(
  again.size === after.size
    ? `PASS: re-running added nobody (still ${again.size} members)`
    : `FAIL: member count grew to ${again.size}`,
);

// 6. a message with no mentions must do nothing
await thread.members.remove(TARGET_ID);
await handleMessage({
  author: captainUser,
  channel: thread,
  mentions: { users: new Map() },
} as unknown as Message);
const noMention = await thread.members.fetch();
console.log(
  !noMention.has(TARGET_ID)
    ? "PASS: a message with no mentions adds nobody"
    : "FAIL: a message with no mentions added somebody",
);

// cleanup
await thread.delete();
console.log("cleaned up test thread");

const ok = added && notice && again.size === after.size && !noMention.has(TARGET_ID);
console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
