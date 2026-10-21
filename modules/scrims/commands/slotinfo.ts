/**
 * The `/scrims slotinfo` subcommand.
 *
 * The source's `slotinfo` ran a hand-written `FULL OUTER JOIN` over the
 * schema-qualified join table (S6, row 16). Ours is a typed query over
 * one table.
 */

import { SlashCommandBuilder } from "discord.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const slotInfoSubcommand: ScrimSubcommand = {
  data: new SlashCommandBuilder()
    .setName("slotinfo")
    .setDescription("Show the slots a user holds.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Which user.")
        .setRequired(true),
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

    const scrims = await repo.listScrims(guild.id);

    const lines: string[] = [];

    for (const scrim of scrims) {
      const slots = await repo.listSlots(scrim.id);

      for (const slot of slots) {
        if (slot.state !== "claimed") continue;
        if (slot.ownerUserId !== user.id) continue;

        const jump = slot.jumpUrl ? ` — [message](${slot.jumpUrl})` : "";

        lines.push(
          `**${scrim.name}** — slot \`${slot.num}\`: \`${slot.teamName ?? "—"}\`${jump}`,
        );
        lines.push(
          `Team: ${slot.members.map((id) => `<@${id}>`).join(", ") || "—"}`,
        );
        lines.push("");
      }
    }

    if (lines.length === 0) {
      await interaction.editReply({
        content: `${user.toString()} doesn't have any slot in any scrim of this server.`,
      });

      return;
    }

    await interaction.editReply({
      content: [
        `**${user.toString()}'s slots**`,
        "",
        ...lines,
        `Requested by ${interaction.user.toString()}`,
      ].join("\n"),
    });
  },
};
