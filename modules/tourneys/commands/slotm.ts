/**
 * The `/tourney slots` subcommand.
 *
 * Shows the **tournament slot manager**: the persistent panel a team
 * uses to cancel its slot, see its groups, rename its team and swap
 * groups.
 *
 * The panel is public — it is the panel the teams use, not a moderator
 * tool — and it is persistent: the tournament's row carries the channel
 * and the message id, so the panel is still there after a restart.
 */

import { ChannelType, SlashCommandSubcommandBuilder } from "discord.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import { buildSlotManagerPanel } from "../views/slotm.js";
import type { TourneySubcommand } from "./types.js";

/** The subcommand. */
export const slotManagerSubcommand: TourneySubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("slots")
    .setDescription("Show the tournament slot manager panel.")
    .addStringOption((option) =>
      option
        .setName("tournament")
        .setDescription("The name or the id of the tournament.")
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Where the panel should be posted.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),

  async run(interaction) {
    const refusal = await canUseTourneyMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    const wanted = interaction.options.getString("tournament", true);

    const tourneys = await repo.listTourneys(guildId);

    const tourney = tourneys.find(
      (entry) =>
        entry.id === wanted ||
        entry.name.toLowerCase() === wanted.toLowerCase(),
    );

    if (!tourney) {
      await interaction.editReply({
        content: "There is no tournament with that name or id in this server.",
      });

      return;
    }

    const channel = interaction.options.getChannel("channel");

    // The panel already lives somewhere: post it there again, so a
    // moderator can put it back where it belongs.
    const target =
      channel && "send" in channel
        ? channel
        : tourney.slotmChannelId
          ? guild.channels.cache.get(tourney.slotmChannelId)
          : null;

    if (!target || !("send" in target)) {
      await interaction.editReply({
        content:
          "The slot manager panel has no channel yet. Pass a channel to put it in one.",
      });

      return;
    }

    const panel = buildSlotManagerPanel(tourney);

    const message = await target
      .send({ embeds: panel.embeds, components: panel.components })
      .catch(() => null);

    if (!message) {
      await interaction.editReply({
        content: "I could not post the slot manager panel in that channel.",
      });

      return;
    }

    await repo.updateTourney(tourney.id, {
      slotmChannelId: target.id,
      slotmMessageId: message.id,
    });

    await interaction.editReply({
      content: `✅ The slot manager panel for **${tourney.name}** is in ${target.toString()}.`,
    });
  },
};
