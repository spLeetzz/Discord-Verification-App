/**
 * The `/tourney open` and `/tourney close` subcommands.
 *
 * The lifecycle is explicit (D26): "open" opens the registration,
 * "close" ends the tournament. There is no "pause" on the command
 * surface — pausing is a button on the panel, because pausing keeps the
 * slots and closing does not, and the two deserve different words.
 */

import { SlashCommandSubcommandBuilder } from "discord.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import {
  closeTourneyInGuild,
  openTourneyInGuild,
} from "../views/lifecycle.js";
import type { TourneySubcommand } from "./types.js";

/** The subcommand. */
export const lifecycleSubcommand: TourneySubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("open")
    .setDescription("Open or close the registration of a tournament.")
    .addStringOption((option) =>
      option
        .setName("tournament")
        .setDescription("The name or the id of the tournament.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("What to do with the registration.")
        .setRequired(true)
        .addChoices(
          { name: "Open", value: "open" },
          { name: "Close", value: "close" },
        ),
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
    const action = interaction.options.getString("action", true);

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

    if (action === "open") {
      const result = await openTourneyInGuild(guild, tourney.id);

      if (!result) {
        await interaction.editReply({
          content: "The tournament could not be opened. Check that I have the permissions I need in the registration channel.",
        });

        return;
      }

      await interaction.editReply({
        content: `✅ The registration of **${result.tourney.name}** is open.`,
      });

      return;
    }

    const result = await closeTourneyInGuild(guild, tourney.id);

    if (!result) {
      await interaction.editReply({
        content: "The tournament could not be closed.",
      });

      return;
    }

    await interaction.editReply({
      content: `✅ The registration of **${result.name}** is closed.`,
    });
  },
};
