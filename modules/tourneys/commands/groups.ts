/**
 * The `/tourney groups` subcommand.
 *
 * Shows the group manager: the groups of a tournament, the button that
 * publishes a group list, and the button that creates the group
 * channels and roles.
 */

import { SlashCommandSubcommandBuilder } from "discord.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { buildGroupManagerPanel } from "../views/groups.js";
import { findGroupCategory } from "../views/button-handlers.js";
import type { TourneySubcommand } from "./types.js";

/** The subcommand. */
export const groupsSubcommand: TourneySubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("groups")
    .setDescription("Manage the groups of a tournament.")
    .addStringOption((option) =>
      option
        .setName("tournament")
        .setDescription("The name or the id of the tournament.")
        .setRequired(true),
    ),

  async run(interaction) {
    const refusal = await canUseTourneyMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

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

    const groups = await service.listGroups(tourney.id);

    if (groups.length === 0) {
      await interaction.editReply({
        content:
          "There are no groups yet. Set the number of teams per group in the editor, and let the teams register first.",
      });

      return;
    }

    const categoryId = await findGroupCategory(interaction.guild, tourney);

    const panel = buildGroupManagerPanel({
      tourney,
      groups,
      current: 1,
      categoryId,
    });

    await interaction.editReply({
      embeds: panel.embeds,
      components: panel.components,
    });
  },
};
