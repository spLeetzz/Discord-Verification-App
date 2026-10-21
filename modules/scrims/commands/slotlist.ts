/**
 * The `/scrims slotlist` subcommand.
 *
 * Posts the slotlist into the current channel.
 */

import { ChannelType, SlashCommandBuilder } from "discord.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import { renderSlotlist, slotListLines } from "../render.js";
import { publishSlotlist } from "../views/slotlist.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const slotListSubcommand: ScrimSubcommand = {
  data: new SlashCommandBuilder()
    .setName("slotlist")
    .setDescription("Post a scrim's slotlist here.")
    .addChannelOption((option) =>
      option
        .setName("registration_channel")
        .setDescription("The scrim's registration channel.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),

  async run(interaction) {
    const refusal = await canUseScrimMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    const registrationChannel = interaction.options.getChannel(
      "registration_channel",
      true,
    );

    const scrim = await repo.getScrimByRegistrationChannel(
      registrationChannel.id,
    );

    if (!scrim || scrim.guildId !== guild.id) {
      await interaction.editReply({
        content: `❌ No scrim found in ${registrationChannel.toString()}.`,
      });

      return;
    }

    const slots = await repo.listSlots(scrim.id);
    const claimed = slots.filter((slot) => slot.state === "claimed");

    if (claimed.length === 0) {
      await interaction.editReply({
        content: `❌ ${scrim.name} has no registrations.`,
      });

      return;
    }

    const channel = interaction.channel;

    if (!channel || !("send" in channel)) {
      await interaction.editReply({
        content: "❌ I cannot post in this channel.",
      });

      return;
    }

    const embed = renderSlotlist(scrim, {
      name: scrim.name,
      elapsedSeconds: scrim.timeElapsedSeconds,
      openTime: scrim.openTime,
      slots: slotListLines(claimed),
    });

    await channel.send({ embeds: [embed] });

    await interaction.editReply({
      content: "✅ Slotlist posted. Use `/scrims manager` to manage the scrim's teams.",
    });
  },
};

/** The function that publishes the slotlist into a channel. */
export { publishSlotlist };
