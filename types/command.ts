import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { Guard } from "../core/guards.js";

/** Anything that can serialise itself into a slash command payload. */
export interface CommandData {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface Command {
  data: CommandData;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;

  /**
   * Only members with the Moderator role (or Administrator) may run it.
   *
   * This is the simple case. A finer rule — a count limit, a premium
   * feature, a role hierarchy — is a {@link Guard} instead.
   */
  staffOnly?: boolean;

  /**
   * Whether the reply is ephemeral.
   *
   * Defaults to **false**, so a command that says nothing is public. That
   * is the right default for a new command: a public reply can be quoted,
   * screenshotted and seen by the people it is about.
   *
   * The pre-existing verification commands set this to `true` explicitly,
   * because they were ephemeral before this flag meant anything and their
   * behaviour is frozen.
   */
  ephemeral?: boolean;

  /**
   * Extra refusals, evaluated after `staffOnly` and before `execute`.
   *
   * A guard returns `null` to allow, or a string to refuse with. Guards
   * never throw past the dispatcher.
   *
   * A single `premium?: boolean` could not express Quotient's gates, because
   * most of them are count-limited rather than boolean — "3 scrims, 1
   * tourney, 1 tagcheck channel" — so the gate is a predicate list.
   */
  guards?: Guard[];

  /**
   * Guild-only by default. Set `false` for a command that works in a DM.
   */
  guildOnly?: boolean;
}
