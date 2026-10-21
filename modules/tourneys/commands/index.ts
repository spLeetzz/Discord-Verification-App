/**
 * The `/tourney` command group.
 *
 * One top-level command with six subcommands. The file in
 * `commands/esports/tourneys.ts` is a one-line re-export of this.
 *
 * **D43: the panel is public.** Other moderators have to be able to see
 * it, so the command does not set `ephemeral`.
 */

import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../../types/command.js";
import { createSubcommand } from "./create.js";
import { groupsSubcommand } from "./groups.js";
import { lifecycleSubcommand } from "./lifecycle.js";
import { panelSubcommand } from "./panel.js";
import { slotManagerSubcommand } from "./slotm.js";
import type { TourneySubcommand } from "./types.js";

/** Every subcommand of `/tourney`, in the order they are shown. */
export const TOURNEY_SUBCOMMANDS: readonly TourneySubcommand[] = [
  panelSubcommand,
  createSubcommand,
  lifecycleSubcommand,
  groupsSubcommand,
  slotManagerSubcommand,
];

/** The command group. */
export const tourneyCommand: Command = {
  staffOnly: true,

  /**
   * D43: the esports commands are public by default, matching Quotient.
   * The management panel has to be visible to the other moderators.
   */
  ephemeral: false,

  data: new SlashCommandBuilder()
    .setName("tourney")
    .setDescription("Manage tournaments.")
    .addSubcommand(panelSubcommand.data)
    .addSubcommand(createSubcommand.data)
    .addSubcommand(lifecycleSubcommand.data)
    .addSubcommand(groupsSubcommand.data)
    .addSubcommand(slotManagerSubcommand.data),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand(false);

    const found = TOURNEY_SUBCOMMANDS.find(
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

export default tourneyCommand;
