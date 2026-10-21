/**
 * `/easytag` — the easy-tag channels.
 *
 * An easy-tag channel is one where the bot turns the raw ids and `@names`
 * in a captain's message into real mentions.
 *
 * The four subcommands are Quotient's four commands:
 * `easytag set`, `easytag remove`, `easytag config` and
 * `easytag autodelete`.
 */

import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, GuildTextChannel } from "discord.js";
import { replyError, replySimple, replySuccess } from "../../../core/context.js";
import { hasGuildPermissions } from "../../../core/guards.js";
import type { Command } from "../../../types/command.js";
import { errorMessage } from "../../../utils/errors.js";
import { ensureIgnoreRole } from "../ignore-role.js";
import * as service from "../service.js";

/** The command object. */
export const easyTagCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("easytag")
    .setDescription(
      "Set up a channel where raw ids and @names are turned into real mentions.",
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Make a channel an easy-tag channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to convert the tags in.")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop converting the tags in a channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to stop converting in.")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Show the easy-tag channels of this server."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("autodelete")
        .setDescription("Delete a message and the bot's answer after a while.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to change.")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    ),

  async execute(interaction) {
    if (!(await hasGuildPermissions(interaction, PermissionFlagsBits.ManageGuild))) {
      await replyError(
        interaction,
        "You need the **Manage Server** permission to use this command.",
      );

      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "set") return setEasyTag(interaction);
    if (subcommand === "remove") return removeEasyTag(interaction);
    if (subcommand === "config") return showEasyTagConfig(interaction);
    if (subcommand === "autodelete") return toggleEasyTagAutoDelete(interaction);

    await replyError(interaction, "Unknown subcommand.");
  },
};

/**
 * `/easytag set`
 */
async function setEasyTag(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await replyError(interaction, "This command only works in a server.");

    return;
  }

  const channel = interaction.options.getChannel("channel", true);

  if (!channel || channel.type !== ChannelType.GuildText) {
    await replyError(interaction, "That is not a text channel.");

    return;
  }

  const textChannel = channel as GuildTextChannel;

  const existing = await service.listEasyTagChannels(guild.id);

  if (existing.some((config) => config.channelId === textChannel.id)) {
    await replyError(interaction, "This channel is already an easy-tag channel.");

    return;
  }

  const permissions = textChannel.permissionsFor(guild.members.me);

  if (
    !permissions?.has([
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageMessages,
    ])
  ) {
    await replyError(
      interaction,
      `I need \`send_messages\`, \`embed_links\` and \`manage_messages\` permission in ${textChannel.mention}`,
    );

    return;
  }

  try {
    const ignoreRoleId = await ensureIgnoreRole(guild);

    await service.setEasyTagChannel({
      guildId: guild.id,
      channelId: textChannel.id,
      ignoreRoleId,
    });

    await replySuccess(
      interaction,
      `Successfully added **${textChannel.name}** to the easy-tag channels.\n\nAdd <@&${ignoreRoleId}> to your roles to ignore your messages in **${textChannel.name}**.\n\nMembers can now write a teammate's id, \`@their_name\` or \`@their_full_discord_tag\` and the bot will turn it into a real mention.`,
    );
  } catch (error) {
    await replyError(interaction, errorMessage(error));
  }
}

/**
 * `/easytag remove`
 */
async function removeEasyTag(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);

  if (!channel) {
    await replyError(interaction, "That is not a text channel.");

    return;
  }

  const records = await service.listEasyTagChannels(interaction.guildId ?? "");

  if (!records.some((record) => record.channelId === channel.id)) {
    await replyError(interaction, "This is not an easy-tag channel.");

    return;
  }

  await service.removeEasyTagChannel(channel.id);

  await replySuccess(
    interaction,
    `Removed <#${channel.id}> from the easy-tag channels.`,
  );
}

/**
 * `/easytag config`
 */
async function showEasyTagConfig(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyError(interaction, "This command only works in a server.");

    return;
  }

  const records = await service.listEasyTagChannels(guildId);

  if (records.length === 0) {
    await replyError(
      interaction,
      "You haven't set any easy-tag channel yet.\n\nUse `/easytag set` to set one up.",
    );

    return;
  }

  const lines = records.map(
    (record, index) =>
      `\`${String(index + 1).padStart(2, "0")}.\` <#${record.channelId}> (Delete After: ${record.deleteAfter ? "On" : "Not Set"})`,
  );

  await replySimple(interaction, lines.join("\n"));
}

/**
 * `/easytag autodelete`
 */
async function toggleEasyTagAutoDelete(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);

  if (!channel) {
    await replyError(interaction, "That is not a text channel.");

    return;
  }

  const records = await service.listEasyTagChannels(
    interaction.guildId ?? "",
  );

  if (!records.some((record) => record.channelId === channel.id)) {
    await replyError(interaction, "This is not an easy-tag channel.");

    return;
  }

  const state = await service.toggleEasyTagAutoDelete(channel.id);

  if (state === null) {
    await replyError(interaction, "This is not an easy-tag channel.");

    return;
  }

  await replySuccess(
    interaction,
    `Delete After for **${channel.name}** turned **${state ? "ON" : "OFF"}**!\n\nThis deletes the message and the bot's answer after some time.`,
  );
}
