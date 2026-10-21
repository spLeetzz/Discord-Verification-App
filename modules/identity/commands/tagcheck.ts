/**
 * `/tagcheck` — the tag-check channels.
 *
 * A tag-check channel is one where a captain registers his team by
 * mentioning his teammates. The message listener checks the mentions,
 * reacts ✅ or ❌ and shows the team's name.
 *
 * The four subcommands are Quotient's four commands:
 * `tagcheck set`, `tagcheck config`, `tagcheck remove` and
 * `tagcheck autodelete`.
 *
 * The file is a thin adapter: it reads the options, calls the service and
 * renders the answer. The rules live in `../tagcheck.ts` and the state
 * machine in `../service.ts`.
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
export const tagCheckCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("tagcheck")
    .setDescription(
      "Set up a channel where a captain registers his team by mentioning his teammates.",
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Make a channel a tag-check channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to check the mentions in.")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addIntegerOption((option) =>
          option
            .setName("mentions")
            .setDescription("How many teammates the captain has to mention.")
            .setMinValue(0)
            .setMaxValue(20),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Show the tag-check channels of this server."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop checking the mentions in a channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to stop checking.")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("autodelete")
        .setDescription("Delete a rejected message after a while.")
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

    if (subcommand === "set") return setTagCheck(interaction);
    if (subcommand === "config") return showTagCheckConfig(interaction);
    if (subcommand === "remove") return removeTagCheck(interaction);
    if (subcommand === "autodelete") return toggleTagCheckAutoDelete(interaction);

    await replyError(interaction, "Unknown subcommand.");
  },
};

/**
 * `/tagcheck set`
 */
async function setTagCheck(
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

  const existing = await service.listTagCheckChannels(guild.id);

  if (existing.some((config) => config.channelId === textChannel.id)) {
    await replyError(interaction, "This channel is already a tag-check channel.");

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

  const mentions = interaction.options.getInteger("mentions") ?? 4;

  try {
    const ignoreRoleId = await ensureIgnoreRole(guild);

    const config = await service.setTagCheckChannel({
      guildId: guild.id,
      channelId: textChannel.id,
      requiredMentions: mentions,
      ignoreRoleId,
    });

    await replySuccess(
      interaction,
      `Successfully added **${textChannel.name}** to tag-check channels.\n\nAdd <@&${ignoreRoleId}> to your roles to ignore your messages in **${textChannel.name}**.\n\nThe channel now needs ${config.requiredMentions} mention${config.requiredMentions === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    await replyError(interaction, errorMessage(error));
  }
}

/**
 * `/tagcheck config`
 */
async function showTagCheckConfig(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyError(interaction, "This command only works in a server.");

    return;
  }

  const records = await service.listTagCheckChannels(guildId);

  if (records.length === 0) {
    await replyError(
      interaction,
      "You haven't set any tag-check channel yet.\n\nUse `/tagcheck set` to set one up.",
    );

    return;
  }

  const lines = records.map(
    (record, index) =>
      `\`${String(index + 1).padStart(2, "0")}.\` <#${record.channelId}> (Mentions: \`${record.requiredMentions}\`, Auto-delete: ${record.deleteAfter ? "On" : "Not Set"})`,
  );

  await replySimple(interaction, lines.join("\n"));
}

/**
 * `/tagcheck remove`
 */
async function removeTagCheck(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);

  if (!channel) {
    await replyError(interaction, "That is not a text channel.");

    return;
  }

  const records = await service.listTagCheckChannels(
    interaction.guildId ?? "",
  );

  if (!records.some((record) => record.channelId === channel.id)) {
    await replyError(interaction, "This is not a tag-check channel.");

    return;
  }

  await service.removeTagCheckChannel(channel.id);

  await replySuccess(
    interaction,
    `Removed <#${channel.id}> from the tag-check channels.`,
  );
}

/**
 * `/tagcheck autodelete`
 */
async function toggleTagCheckAutoDelete(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);

  if (!channel) {
    await replyError(interaction, "That is not a text channel.");

    return;
  }

  const records = await service.listTagCheckChannels(
    interaction.guildId ?? "",
  );

  if (!records.some((record) => record.channelId === channel.id)) {
    await replyError(interaction, "This is not a tag-check channel.");

    return;
  }

  const state = await service.toggleTagCheckAutoDelete(channel.id);

  if (state === null) {
    await replyError(interaction, "This is not a tag-check channel.");

    return;
  }

  await replySuccess(
    interaction,
    `Auto-delete for **${channel.name}** turned **${state ? "ON" : "OFF"}**!\nThis automatically deletes the wrong format message after some time.`,
  );
}
