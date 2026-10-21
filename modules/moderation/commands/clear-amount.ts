/**
 * `/clear-amount` — delete the last N messages.
 *
 * The number half of Quotient's `clear` group, split out because a
 * required positional argument alongside subcommands is ambiguous
 * (D44).
 */

import { SlashCommandBuilder } from "discord.js";
import { PURGE_SEARCH_LIMIT } from "../purge.js";
import { purgeMessages } from "../purge-service.js";
import type { ModerationCommand } from "../types.js";
import { purgePanel, replyPanel } from "../views/panels.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireTextChannel,
  runCommand,
} from "./shared.js";

const clearAmountCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageMessages,
      missingPermission("manage_messages"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("clear-amount")
    .setDescription("Delete the last messages in this channel.")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("How many messages to delete.")
        .setMinValue(1)
        .setMaxValue(PURGE_SEARCH_LIMIT)
        .setRequired(true),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const channel = requireTextChannel(interaction);
      const amount = interaction.options.getInteger("amount") ?? 1;

      const outcome = await purgeMessages({
        channel,
        filter: { kind: "all" },
        search: amount,
      });

      await replyPanel(
        interaction,
        purgePanel(outcome, {
          title: "Messages purged",
          description: `${outcome.deleted} message${
            outcome.deleted === 1 ? " was" : "s were"
          } removed.`,
          emptyDescription: "There were no messages to delete.",
        }),
      );
    });
  },
};

export default clearAmountCommand;
