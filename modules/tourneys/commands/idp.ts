/**
 * The `/idp` command — "ID-Pass".
 *
 * Quotient's `idp` command shared a custom room's credentials: the room
 * id, the password and the map. The bot posted an embed with the three
 * values and a "Get in Copy Format" button, and the message deleted
 * itself after thirty minutes so the password did not linger in the
 * channel.
 *
 * **The reply is ephemeral (D23).** Quotient deleted the *user's* message
 * to hide the password, because a slash command has no user message to
 * delete. The equivalent is an ephemeral reply: the command's own answer
 * never carries the password. The credentials live in a *separate* public
 * message — the source's behaviour — that deletes itself.
 *
 * **The password never reaches a log line.** It is not in the reply, not
 * in the job payload, and not in an error message. The job row carries
 * the channel id and the message id, which is all the deletion needs.
 *
 * **This is not the slots area's "Transfer IDP Role".** That is a
 * different feature with an unfortunately similar name; this one only
 * shares a room's credentials.
 */

import { SlashCommandBuilder } from "discord.js";
import { respond } from "../../../core/context.js";
import type { Command } from "../../../types/command.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import {
  buildIdpComponents,
  buildIdpEmbed,
  IDP_LIFETIME_MINUTES,
  IDP_LIFETIME_MS,
} from "../views/idp.js";

/** The command. */
export const idpCommand: Command = {
  /**
   * D23: the reply is ephemeral. The command's answer is a confirmation
   * and nothing else — the password is in the message it posts, and that
   * message deletes itself.
   */
  ephemeral: true,

  /**
   * The area's staff guard: Administrator, **Manage Server**, the
   * `tourney-mod` role or the guild's `Moderator` role. The source wanted
   * `manage_guild` or the `scrims-mod` role; this is the same rule with
   * the area's own role names.
   */
  guards: [canUseTourneyMod],

  data: new SlashCommandBuilder()
    .setName("idp")
    .setDescription(
      "Share a custom room's id, password and map. The message deletes itself in 30 minutes.",
    )
    .addStringOption((option) =>
      option
        .setName("room_id")
        .setDescription("The room id the teams type in.")
        .setMaxLength(100)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("password")
        .setDescription("The room's password.")
        .setMaxLength(100)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("map")
        .setDescription("The map the room is set to.")
        .setMaxLength(100)
        .setRequired(true),
    )
    .addRoleOption((option) =>
      option
        .setName("ping_role")
        .setDescription("A role to ping with the room details.")
        .setRequired(false),
    ),

  async execute(interaction) {
    const roomId = interaction.options.getString("room_id", true).trim();
    const password = interaction.options.getString("password", true);
    const map = interaction.options.getString("map", true).trim();
    const pingRole = interaction.options.getRole("ping_role");

    if (!roomId || !map) {
      await respond(
        interaction,
        { content: "The room id and the map cannot be empty." },
        true,
      );

      return;
    }

    const channel = interaction.channel;

    if (!channel || !("send" in channel)) {
      await respond(
        interaction,
        { content: "I cannot post in this channel." },
        true,
      );

      return;
    }

    const message = await channel.send({
      // The ping is the only thing in the content: a mention inside an
      // embed does not ping, so the role has to be mentioned out here.
      content: pingRole ? `<@&${pingRole.id}>` : undefined,
      embeds: [buildIdpEmbed({ roomId, password, map })],
      components: buildIdpComponents(),
      allowedMentions: {
        // Only the role the caller named may be pinged. Nothing else — not
        // @everyone, and not the room id or the password.
        parse: [],
        roles: pingRole ? [pingRole.id] : [],
      },
    });

    // The message deletes itself. The job row carries the two ids the
    // deletion needs and nothing else — in particular, not the password.
    await repo.scheduleMessageDelete(
      { channelId: channel.id, messageId: message.id },
      new Date(Date.now() + IDP_LIFETIME_MS),
    );

    await respond(
      interaction,
      {
        content: `The room details have been posted. The message deletes itself in ${IDP_LIFETIME_MINUTES} minutes.`,
      },
      true,
    );
  },
};

export default idpCommand;
