/**
 * `/autopurge` — delete the messages in a channel after a delay.
 *
 * The source created one timer row per message, and that is kept: a timer
 * that dies with the process leaves the message behind for ever, and a
 * "delete everything older than N" pass would delete a message that was
 * posted after the pass was armed.
 *
 * The free-tier check is in `rules.ts`, and the **order** of the two
 * checks is the source's bug fixed: "this channel is already an auto-purge
 * channel" comes before "you have reached the free-tier limit".
 */

import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { parseDuration } from "../../../core/time.js";
import { autoPurgeChannels } from "../cache.js";
import * as service from "../service.js";
import { buildAutoPurgeListEmbed } from "../views/embeds.js";
import { respondSafe } from "../views/reply.js";
import {
  missingPermission,
  permissionGuard,
  requireGuild,
  requirePermission,
  runCommand,
} from "./shared.js";
import type { CommunityCommand } from "./shared.js";

/** The shortest a purge delay may be, in seconds. */
const MINIMUM_DELAY_SECONDS = 5;

/** The longest a purge delay may be, in seconds: seven days. */
const MAXIMUM_DELAY_SECONDS = 604_800;

/**
 * Reads the delay out of the option.
 *
 * The source's format was `s|m|h|d` — `1h30m`. The port uses
 * `core/time.ts`'s `parseDuration`, which understands the same units and
 * weeks as well.
 *
 * @returns the delay in seconds.
 */
export function parsePurgeDelay(input: string): number {
  const milliseconds = parseDuration(input);

  if (milliseconds === null) {
    throw new InputError(
      "I could not read that delay. Try something like `10m`, `1h30m` or `2d`.",
    );
  }

  const seconds = Math.round(milliseconds / 1000);

  if (seconds <= MINIMUM_DELAY_SECONDS || seconds > MAXIMUM_DELAY_SECONDS) {
    throw new InputError("The delay must be more than 5 seconds and at most 7 days.");
  }

  return seconds;
}

const autopurgeCommand: CommunityCommand = {
  data: new SlashCommandBuilder()
    .setName("autopurge")
    .setDescription("Delete the messages in a channel after a delay.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a channel up for auto-purge.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to purge.")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("delete_after")
            .setDescription("How long a message lives, e.g. `10m` or `1h30m`.")
            .setMaxLength(30)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List the auto-purge channels."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop auto-purging a channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to stop purging.")
            .setRequired(true),
        ),
    ),

  guards: [
    permissionGuard(
      PermissionFlagsBits.ManageMessages,
      missingPermission("manage_messages"),
    ),
  ],

  async execute(interaction) {
    await runCommand(interaction, async () => {
      await requirePermission(
        interaction,
        PermissionFlagsBits.ManageMessages,
        "manage_messages",
      );

      switch (interaction.options.getSubcommand()) {
        case "set":
          await setAutoPurge(interaction);
          return;
        case "list":
          await listAutoPurge(interaction);
          return;
        case "remove":
          await removeAutoPurge(interaction);
          return;
        default:
          throw new InputError("I do not know that auto-purge command.");
      }
    });
  },
};

/**
 * Sets a channel up for auto-purge.
 */
async function setAutoPurge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  const option = interaction.options.getChannel("channel");

  if (!option) {
    throw new InputError("Please pick a channel.");
  }

  const channel =
    guild.channels.cache.get(option.id) ??
    (await guild.channels.fetch(option.id).catch(() => null));

  if (!channel) {
    throw new InputError("That channel is not in this server.");
  }

  if (!("send" in channel)) {
    throw new InputError("That channel cannot hold messages.");
  }

  const me = guild.members.me;

  if (!me) {
    throw new InputError("I could not find my own member record.");
  }

  if (!channel.permissionsFor(me).has(PermissionFlagsBits.ManageMessages)) {
    throw new InputError(
      `I need the \`manage_messages\` permission in ${channel.toString()}.`,
    );
  }

  const delay = parsePurgeDelay(interaction.options.getString("delete_after") ?? "");

  const config = await service.configureAutoPurge({
    guildId: guild.id,
    channelId: channel.id,
    channelName: channel.toString(),
    deleteAfter: delay,
  });

  // The cache is the listener's fast path; one place owns it.
  autoPurgeChannels.add(config.channelId);

  await respondSafe(interaction, {
    content: `${channel.toString()} will have its messages deleted after ${delay} seconds.`,
  });
}

/**
 * Lists the auto-purge channels.
 */
async function listAutoPurge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  const configs = await service.listAutoPurgeConfigs(guild.id);

  if (configs.length === 0) {
    throw new InputError("This server has no auto-purge channels.");
  }

  const names = new Map<string, string>();

  for (const config of configs) {
    const channel = guild.channels.cache.get(config.channelId);

    names.set(config.channelId, channel?.toString() ?? "Deleted Channel");
  }

  await respondSafe(interaction, {
    embeds: [buildAutoPurgeListEmbed(configs, names)],
  });
}

/**
 * Stops auto-purging a channel.
 */
async function removeAutoPurge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const option = interaction.options.getChannel("channel");

  if (!option) {
    throw new InputError("Please pick a channel.");
  }

  const removed = await service.removeAutoPurge(option.id);

  if (!removed) {
    throw new InputError("That channel is not an auto-purge channel.");
  }

  autoPurgeChannels.discard(option.id);

  await respondSafe(interaction, {
    content: "That channel is no longer an auto-purge channel.",
  });
}

export default autopurgeCommand;
