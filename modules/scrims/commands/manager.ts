/**
 * The `/scrims manager` subcommand.
 *
 * The management panel. The scrim is picked from the list panel's select
 * menu, and every panel after that carries the scrim's id in its custom
 * id (D18) — so a panel survives a restart.
 */

import { SlashCommandSubcommandBuilder } from "discord.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import { buildListPanel } from "../views/manager.js";
import { canCreateScrim } from "../views/button-handlers.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const managerSubcommand: ScrimSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("manager")
    .setDescription("Open the scrims management panel."),

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

    const scrims = await repo.listScrims(guild.id);
    const panel = buildListPanel(scrims, await canCreateScrim(guild.id));

    await interaction.editReply({
      embeds: panel.embeds,
      components: panel.components,
    });
  },
};
