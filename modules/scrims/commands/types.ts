/**
 * The shape of a scrims subcommand.
 *
 * A slash command with subcommands is one command with several
 * definitions, so each subcommand contributes a builder and a handler.
 */

import type {
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";

/** One subcommand of `/scrims`. */
export interface ScrimSubcommand {
  /** The definition the deploy script registers. */
  readonly data: SlashCommandOptionsOnlyBuilder;
  /** What it does when it is run. */
  readonly run: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
