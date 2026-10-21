/**
 * The shape of a tourneys subcommand.
 *
 * A slash command with subcommands is one command with several
 * definitions, so each subcommand contributes a builder and a handler.
 */

import type {
  ChatInputCommandInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";

/** One subcommand of `/tourney`. */
export interface TourneySubcommand {
  /** The definition the deploy script registers. */
  readonly data: SlashCommandSubcommandBuilder;
  /** What it does when it is run. */
  readonly run: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
