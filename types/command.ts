import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

/** Anything that can serialise itself into a slash command payload. */
export interface CommandData {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface Command {
  data: CommandData;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  /** Only members with the Moderator role (or Administrator) may run it. */
  staffOnly?: boolean;
  /** Reserved for future use; the interaction handler currently always defers ephemerally. */
  ephemeral?: boolean;
}
