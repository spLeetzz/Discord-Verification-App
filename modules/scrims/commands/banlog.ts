/**
 * The `/scrims banlog` subcommand.
 *
 * The source's `q banlog` set the channel that ban and unban entries are
 * written to, or showed the current one when no channel was given. The
 * `ban_logs` table is one row per guild (`UNIQUE (guild_id)`), so setting
 * it again replaces the row rather than adding a second one.
 *
 * **This is the setup surface the table was missing.** The table and its
 * query helpers existed with nothing to write to them; without this
 * command a guild could not point the ban log anywhere.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { SlashCommandSubcommandBuilder } from "discord.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const banLogSubcommand: ScrimSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("banlog")
    .setDescription("Show or set the channel ban entries are written to.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel to write ban entries to.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),

  async run(interaction) {
    const refusal = await canUseScrimMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    const channel = interaction.options.getChannel("channel", false, [
      ChannelType.GuildText,
    ]);

    if (!channel) {
      const current = await repo.getBanLogChannel(guild.id);

      await interaction.editReply({
        content: current
          ? `📝 The ban log of this server goes to <#${current}>.`
          : "📝 No ban log channel is set for this server. Run `/scrims banlog` with a channel to set one.",
      });

      return;
    }

    // The option only offers text channels, but a channel in another
    // guild can still arrive here through the API, and a channel the bot
    // cannot read is a channel that cannot hold a ban log.
    if (channel.guild.id !== guild.id) {
      await interaction.editReply({
        content: "❌ That channel is not in this server.",
      });

      return;
    }

    const me = guild.members.me;

    if (!me) {
      await interaction.editReply({
        content: "❌ I could not find my own member record.",
      });

      return;
    }

    if (!("permissionsFor" in channel)) {
      await interaction.editReply({
        content: "❌ That channel cannot hold a ban log.",
      });

      return;
    }

    const permissions = channel.permissionsFor(me);

    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
      await interaction.editReply({
        content: `❌ I cannot see ${channel.toString()}.`,
      });

      return;
    }

    if (!permissions.has(PermissionFlagsBits.SendMessages)) {
      await interaction.editReply({
        content: `❌ I cannot send messages in ${channel.toString()}.`,
      });

      return;
    }

    await repo.setBanLogChannel(guild.id, channel.id);

    await interaction.editReply({
      content: `✅ The ban log of this server now goes to ${channel.toString()}.`,
    });
  },
};
