/**
 * The `/scrims reserve` subcommand.
 *
 * **The source's `reserve` had no permission check at all** (D44): any
 * member could reserve a slot in any scrim. Ours has the mod guard.
 */

import { ChannelType, SlashCommandSubcommandBuilder } from "discord.js";
import { parseNaturalTime } from "../../../core/time.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const reserveSubcommand: ScrimSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("reserve")
    .setDescription("Reserve a slot in a scrim.")
    .addChannelOption((option) =>
      option
        .setName("registration_channel")
        .setDescription("The scrim's registration channel.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("slot")
        .setDescription("Which slot to reserve.")
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("team_name")
        .setDescription("The name of the team.")
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Who the slot is reserved for.")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("expire_time")
        .setDescription("When the reservation expires (IST).")
        .setRequired(false),
    ),

  async run(interaction) {
    const refusal = await canUseScrimMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const registrationChannel = interaction.options.getChannel(
      "registration_channel",
      true,
    );
    const num = interaction.options.getInteger("slot", true);
    const teamName = interaction.options.getString("team_name", true);
    const user = interaction.options.getUser("user");
    const expireText = interaction.options.getString("expire_time");

    const scrim = await repo.getScrimByRegistrationChannel(
      registrationChannel.id,
    );

    if (!scrim) {
      await interaction.editReply({
        content: `❌ No scrim found in ${registrationChannel.toString()}.`,
      });

      return;
    }

    const expires = expireText ? parseNaturalTime(expireText) : null;

    if (expireText && !expires) {
      await interaction.editReply({
        content: "❌ I could not understand that expiry time.",
      });

      return;
    }

    try {
      await service.reserveSlot({
        scrimId: scrim.id,
        num,
        teamName,
        ownerUserId: user?.id ?? null,
        members: user ? [user.id] : [],
        expires,
      });
    } catch (error) {
      await interaction.editReply({
        content: `❌ ${
          error instanceof Error ? error.message : "The slot could not be reserved."
        }`,
      });

      return;
    }

    await interaction.editReply({
      content: `✅ Slot \`${num}\` has been reserved for \`${teamName}\` in ${registrationChannel.toString()}.${
        expires ? ` It expires <t:${Math.floor(expires.getTime() / 1000)}:f>.` : " It never expires."
      }`,
    });
  },
};
