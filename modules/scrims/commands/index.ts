/**
 * The `/scrims` command group.
 *
 * One top-level command with six subcommands. The file in
 * `commands/esports/scrims.ts` is a one-line re-export of this.
 */

import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../../types/command.js";
import { createSubcommand } from "./create.js";
import { managerSubcommand } from "./manager.js";
import { reserveSubcommand } from "./reserve.js";
import { slotInfoSubcommand } from "./slotinfo.js";
import { slotListSubcommand } from "./slotlist.js";
import { unbanSubcommand } from "./unban.js";
import type { ScrimSubcommand } from "./types.js";

/** Every subcommand of `/scrims`, in the order they are shown. */
export const SCRIM_SUBCOMMANDS: readonly ScrimSubcommand[] = [
  managerSubcommand,
  createSubcommand,
  reserveSubcommand,
  unbanSubcommand,
  slotInfoSubcommand,
  slotListSubcommand,
];

/** The command group. */
export const scrimsCommand: Command = {
  staffOnly: true,
  /**
   * D43: the esports commands are public by default, matching Quotient.
   * The dispatcher has to honour this flag; today it defers every
   * command ephemerally.
   */
  ephemeral: false,
  data: new SlashCommandBuilder()
    .setName("scrims")
    .setDescription("Manage scrims.")
    .addSubcommand(managerSubcommand.data)
    .addSubcommand(createSubcommand.data)
    .addSubcommand(reserveSubcommand.data)
    .addSubcommand(unbanSubcommand.data)
    .addSubcommand(slotInfoSubcommand.data)
    .addSubcommand(slotListSubcommand.data),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand(false);

    const found = SCRIM_SUBCOMMANDS.find(
      (entry) => entry.data.name === subcommand,
    );

    if (!found) {
      await interaction.editReply({
        content: "That subcommand is no longer available. Please try again.",
      });

      return;
    }

    await found.run(interaction);
  },
};

export default scrimsCommand;
