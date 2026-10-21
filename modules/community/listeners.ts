/**
 * The event listeners this area owns.
 *
 * Four listeners, and every one of them is a thing that has to survive a
 * restart:
 *
 *  - a deleted message is remembered, so `/snipe` can show it;
 *  - a message in an auto-purge channel arms a job that deletes it;
 *  - a member who joins is given the guild's auto-roles;
 *  - a channel that is deleted is taken off the auto-purge list.
 *
 * The `client.on(...)` calls live here and nowhere else (D38).
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client, GuildMember, Message } from "discord.js";
import { run } from "../../core/fire-and-forget.js";
import { logger } from "../../utils/logger.js";
import { autoPurgeChannels } from "./cache.js";
import { ensureDailyJob } from "./jobs.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { staleRoleIds } from "./rules.js";

/** The text a message with no content is remembered as. */
const NO_CONTENT = "*[Content Unavailable]*";

/**
 * Is this channel NSFW?
 *
 * `nsfw` is on the text channels and the threads; it is not on a DM, so
 * the check is a property test rather than a cast.
 */
export function isNsfwChannel(channel: unknown): boolean {
  if (typeof channel !== "object" || channel === null) return false;

  if (!("nsfw" in channel)) return false;

  const value = (channel as { nsfw?: unknown }).nsfw;

  return typeof value === "boolean" ? value : false;
}

/**
 * The channels a deleted message is remembered in.
 *
 * The source remembered text channels and the two kinds of thread, and
 * nothing else.
 */
export function isSnipeableChannel(channel: {
  type?: ChannelType;
}): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.type === ChannelType.GuildPublicThread ||
    channel.type === ChannelType.GuildPrivateThread ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  );
}

/**
 * Registers the community listeners.
 *
 * The manager calls this from `handlers/listeners.ts`.
 */
export function registerCommunityListeners(client: Client): void {
  client.on("messageDelete", (message) => {
    run(async () => {
      await onMessageDelete(message);
    }, "community.messageDelete");
  });

  client.on("messageCreate", (message) => {
    run(async () => {
      await onMessageCreate(message);
    }, "community.messageCreate");
  });

  client.on("guildMemberAdd", (member) => {
    run(async () => {
      await onGuildMemberAdd(member);
    }, "community.guildMemberAdd");
  });

  client.on("channelDelete", (channel) => {
    run(async () => {
      await onChannelDelete(channel.id);
    }, "community.channelDelete");
  });

  // The cache is rebuilt at startup, so the auto-purge listener does not
  // ask the database about every message it sees.
  run(async () => {
    await rebuildAutoPurgeCache();
  }, "community.rebuildAutoPurgeCache");

  // The daily housekeeping row has to exist, or the pass never runs: the
  // row is what the scheduler picks up.
  run(async () => {
    await ensureDailyJob();
  }, "community.ensureDailyJob");

  logger.info(
    `[Community] Registered. The auto-purge cache holds ${autoPurgeChannels.size} channel(s).`,
  );
}

/**
 * Rebuilds the auto-purge channel cache from the database.
 */
export async function rebuildAutoPurgeCache(): Promise<void> {
  const ids = await repo.listAutoPurgeChannelIds();

  autoPurgeChannels.replace(ids);
}

/* ------------------------------------------------------------------ *
 * The snipe
 * ------------------------------------------------------------------ */

/**
 * Remembers a deleted message.
 *
 * The source skipped bot messages and channels that are not text
 * channels, and so does this.
 */
export async function onMessageDelete(message: Message): Promise<void> {
  if (!message.guild) return;
  if (message.author.bot) return;

  const channel = message.channel;

  if (!channel || !isSnipeableChannel(channel)) return;

  await service.recordSnipe({
    channelId: channel.id,
    authorId: message.author.id,
    content: message.content || NO_CONTENT,
    nsfw: isNsfwChannel(channel),
  });
}

/* ------------------------------------------------------------------ *
 * Auto-purge
 * ------------------------------------------------------------------ */

/**
 * Arms the job that deletes a message in an auto-purge channel.
 *
 * One job row per message. That is a lot of rows, and it is the right
 * answer: a timer that dies with the process leaves the message behind
 * for ever, and a single "delete everything older than N" pass would
 * delete a message that was posted after the pass was armed.
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (!message.guild) return;

  const channelId = message.channel?.id;

  if (!channelId) return;

  if (!autoPurgeChannels.has(channelId)) return;

  const config = await service.getAutoPurgeConfig(channelId);

  if (!config) {
    // The cache is out of date. One place owns the invalidation.
    autoPurgeChannels.discard(channelId);
    return;
  }

  const delayMs = Math.max(0, config.deleteAfter) * 1000;

  await repo.insertJob({
    expiresAt: new Date(Date.now() + delayMs),
    event: "autopurge",
    payload: {
      channelId,
      messageId: message.id,
    },
  });
}

/**
 * Takes a deleted channel off the auto-purge list.
 */
export async function onChannelDelete(channelId: string): Promise<void> {
  const removed = await service.removeAutoPurge(channelId);

  if (removed) autoPurgeChannels.discard(channelId);
}

/* ------------------------------------------------------------------ *
 * Auto-roles
 * ------------------------------------------------------------------ */

/**
 * Gives a new member the guild's auto-roles.
 *
 * The list is self-healing: a role that no longer exists is dropped from
 * the list instead of failing the grant, because a role that was deleted
 * while the bot was down would otherwise fail **every** join.
 */
export async function onGuildMemberAdd(member: GuildMember): Promise<void> {
  const guild = member.guild;

  const config = await service.getAutoroleConfig(guild.id);

  if (!config) return;

  const kind = member.bot ? "bots" : "humans";

  const configured = config[kind];

  if (configured.length === 0) return;

  const existing = guild.roles.cache.map((role) => role.id);

  const missing = staleRoleIds(configured, existing);

  for (const roleId of missing) {
    logger.warn(
      `[Community] The role ${roleId} no longer exists, so it was dropped from the ${kind} auto-roles of ${guild.id}.`,
    );

    await service.forgetAutoroleRole({
      guildId: guild.id,
      kind,
      roleId,
    });
  }

  const usable = configured.filter((roleId) => !missing.includes(roleId));

  if (usable.length === 0) return;

  const botMember = guild.members.me;

  if (!botMember) {
    logger.warn(
      `[Community] I have no member record in ${guild.id}, so the auto-roles were not granted.`,
    );
    return;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    logger.warn(
      `[Community] I cannot manage roles in ${guild.id}, so the auto-roles were not granted.`,
    );
    return;
  }

  for (const roleId of usable) {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      await service.forgetAutoroleRole({
        guildId: guild.id,
        kind,
        roleId,
      });
      continue;
    }

    try {
      await member.roles.add(role, "Auto-role");
    } catch (error) {
      logger.warn(
        `[Community] Could not give ${roleId} to ${member.id}: ${String(error)}`,
      );

      // A role the bot cannot give is a role that will never work.
      // Drop it rather than failing every join.
      await service.forgetAutoroleRole({
        guildId: guild.id,
        kind,
        roleId,
      });
    }
  }
}
