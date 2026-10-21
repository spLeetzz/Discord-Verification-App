/**
 * The `/scrims unban` subcommand.
 *
 * The source's `unban` ran a hand-written `FULL OUTER JOIN` over the
 * schema-qualified join table (S6, row 15). Ours is a typed query.
 */

import { SlashCommandBuilder } from "discord.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const unbanSubcommand: ScrimSubcommand = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user from the scrims of this server.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Who to unban.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being unbanned.")
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

    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason");

    const scrimIds = await repo.listScrimsBanning(guild.id, user.id);

    if (scrimIds.length === 0) {
      await interaction.editReply({
        content: `${user.toString()} is not banned from any scrim in this server.`,
      });

      return;
    }

    for (const scrimId of scrimIds) {
      await service.unbanUser(scrimId, user.id);
    }

    await interaction.editReply({
      content: `✅ ${user.toString()} has been unbanned from ${scrimIds.length} scrim(s).${
        reason ? ` Reason: ${reason}` : ""
      }`,
    });
  },
};
