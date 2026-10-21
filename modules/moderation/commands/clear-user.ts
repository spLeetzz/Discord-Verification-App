/**
 * `/clear-user` — delete one member's messages.
 *
 * The member half of Quotient's `clear` group, split out because a
 * required positional argument alongside subcommands is ambiguous
 * (D44).
 */

import { SlashCommandBuilder } from "discord.js";
import { PURGE_SEARCH_LIMIT } from "../purge.js";
import { purgeMessages } from "../purge-service.js";
import type { ModerationCommand } from "../types.js";
import { purgePanel, refusalPanel, replyPanel } from "../views/panels.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireTextChannel,
  runCommand,
} from "./shared.js";

/** The default number of messages the filter looks at. */
const DEFAULT_SEARCH = 100;

const clearUserCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageMessages,
      missingPermission("manage_messages"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("clear-user")
    .setDescription("Delete the messages of one member in this channel.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member whose messages to delete.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("search")
        .setDescription("How many messages to look at.")
        .setMinValue(1)
        .setMaxValue(PURGE_SEARCH_LIMIT),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const channel = requireTextChannel(interaction);
      const user = interaction.options.getUser("user");

      if (!user) {
        await replyPanel(
          interaction,
          refusalPanel(interaction.commandName, "Please pick a member."),
        );
        return;
      }

      const search = interaction.options.getInteger("search") ?? DEFAULT_SEARCH;

      const outcome = await purgeMessages({
        channel,
        filter: { kind: "user", userId: user.id },
        search,
      });

      await replyPanel(
        interaction,
        purgePanel(outcome, {
          title: "Messages purged",
          description: `${outcome.deleted} message${
            outcome.deleted === 1 ? "" : "s"
          } by ${user.username} removed.`,
          emptyDescription: `${user.username} has no messages in the last ${search} messages.`,
        }),
      );
    });
  },
};

export default clearUserCommand;
