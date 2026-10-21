/**
 * `/clear` — the filter variants.
 *
 * Quotient's `clear` group declared a required positional argument
 * *alongside* its subcommands, which is ambiguous in discord.py: the
 * `None` fallbacks in the group body were dead code (D44). Slash commands
 * have no such ambiguity, so the group is split: `/clear-amount` takes a
 * number, `/clear-user` takes a user, and everything else is a
 * subcommand of `/clear`.
 */

import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandIntegerOption } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { PURGE_SEARCH_LIMIT, validateContains } from "../purge.js";
import { clearReactions, purgeMessages } from "../purge-service.js";
import type { ModerationCommand, PurgeFilter } from "../types.js";
import { outcomePanel, purgePanel, replyPanel } from "../views/panels.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireTextChannel,
  runCommand,
} from "./shared.js";

/** The default number of messages a filter looks at. */
const DEFAULT_SEARCH = 100;

/** The `search` option every filter carries. */
function searchOption(
  option: SlashCommandIntegerOption,
): SlashCommandIntegerOption {
  return option
    .setName("search")
    .setDescription("How many messages to look at.")
    .setMinValue(1)
    .setMaxValue(PURGE_SEARCH_LIMIT);
}

const clearCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageMessages,
      missingPermission("manage_messages"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Bulk-delete messages in this channel.")
    .addSubcommand((sub) =>
      sub
        .setName("embeds")
        .setDescription("Delete the messages that carry an embed.")
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("files")
        .setDescription("Delete the messages that carry an attachment.")
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("images")
        .setDescription("Delete the messages that carry an embed or an attachment.")
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("all")
        .setDescription("Delete every message that is not pinned.")
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("user")
        .setDescription("Delete the messages of one member.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The member whose messages to delete.")
            .setRequired(true),
        )
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("contains")
        .setDescription("Delete the messages that contain a substring.")
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription("The text to look for.")
            .setMinLength(3)
            .setMaxLength(200)
            .setRequired(true),
        )
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("bot")
        .setDescription("Delete the bot's messages, optionally by prefix.")
        .addStringOption((option) =>
          option
            .setName("prefix")
            .setDescription("Only messages that start with this prefix.")
            .setMaxLength(20),
        )
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("emoji")
        .setDescription("Delete the messages that carry a custom emoji.")
        .addIntegerOption(searchOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reactions")
        .setDescription("Remove the reactions from the messages that have any.")
        .addIntegerOption(searchOption),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const channel = requireTextChannel(interaction);
      const subcommand = interaction.options.getSubcommand();
      const search = interaction.options.getInteger("search") ?? DEFAULT_SEARCH;

      if (subcommand === "reactions") {
        const outcome = await clearReactions({ channel, search });

        await replyPanel(
          interaction,
          outcomePanel({
            kind: "neutral",
            title: "Reactions cleared",
            description: `Removed ${outcome.removed} reaction${
              outcome.removed === 1 ? "" : "s"
            } from ${outcome.withReactions} message${
              outcome.withReactions === 1 ? "" : "s"
            }.`,
            fields: [
              {
                name: "Messages looked at",
                value: String(outcome.scanned),
                inline: true,
              },
            ],
            footer: "The messages themselves stay where they are.",
          }),
        );

        return;
      }

      const filter = buildFilter(subcommand, interaction);
      const outcome = await purgeMessages({ channel, filter, search });

      await replyPanel(
        interaction,
        purgePanel(outcome, {
          title: "Messages purged",
          description: `${outcome.deleted} message${
            outcome.deleted === 1 ? " was" : "s were"
          } removed.`,
          emptyDescription: "No messages matched the filter.",
        }),
      );
    });
  },
};

/**
 * The filter the subcommand asks for.
 */
function buildFilter(
  subcommand: string,
  interaction: { options: { getUser(name: string): { id: string } | null; getString(name: string): string | null } },
): PurgeFilter {
  switch (subcommand) {
    case "embeds":
      return { kind: "embeds" };
    case "files":
      return { kind: "files" };
    case "images":
      return { kind: "images" };
    case "all":
      return { kind: "all" };
    case "user": {
      const user = interaction.options.getUser("user");
      if (!user) throw new Error("The user option is required.");

      return { kind: "user", userId: user.id };
    }
    case "contains": {
      const text = interaction.options.getString("text") ?? "";
      const refusal = validateContains(text);

      if (refusal) throw new InputError(refusal);

      return { kind: "contains", text };
    }
    case "bot":
      return { kind: "bot", prefix: interaction.options.getString("prefix") };
    case "emoji":
      return { kind: "emoji" };
    default:
      throw new Error(`Unknown clear subcommand: ${subcommand}`);
  }
}

export default clearCommand;
