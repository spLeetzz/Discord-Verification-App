/**
 * The `/tourney panel` subcommand.
 *
 * Shows the management panel: the guild's tournaments and a way into
 * each of them.
 *
 * **The panel is public** (D43): other moderators have to be able to see
 * it.
 */

import { SlashCommandSubcommandBuilder } from "discord.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import { buildManagerPanel } from "../views/manager.js";
import type { TourneySubcommand } from "./types.js";

/** The subcommand. */
export const panelSubcommand: TourneySubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("panel")
    .setDescription("Show the tournament management panel."),

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

    const tourneys = await repo.listTourneys(guildId);

    const panel = buildManagerPanel(tourneys);

    await interaction.editReply({
      embeds: panel.embeds,
      components: panel.components,
    });
  },
};
