/**
 * The `/scrims` command group.
 *
 * One top-level command with seven subcommands. The file in
 * `commands/esports/scrims.ts` is a one-line re-export of this.
 */

import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../../types/command.js";
import { scrimsModGuard } from "../guards.js";
import { banLogSubcommand } from "./banlog.js";
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
  banLogSubcommand,
  slotInfoSubcommand,
  slotListSubcommand,
];

/** The command group. */
export const scrimsCommand: Command = {
  /**
   * D43: the esports commands are public by default, matching Quotient.
   */
  ephemeral: false,
  /**
   * The scrim mod guard, and **not** `staffOnly`.
   *
   * The source's `/scrims` asked for `manage_guild` or the `scrims-mod`
   * role, not the guild's `Moderator` role. A `staffOnly` command would
   * be refused by the dispatcher before this guard ever ran, so a
   * `scrims-mod` member who is not staff could not use it.
   */
  guards: [scrimsModGuard],
  data: new SlashCommandBuilder()
    .setName("scrims")
    .setDescription("Manage scrims.")
    .addSubcommand(managerSubcommand.data)
    .addSubcommand(createSubcommand.data)
    .addSubcommand(reserveSubcommand.data)
    .addSubcommand(unbanSubcommand.data)
    .addSubcommand(banLogSubcommand.data)
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
