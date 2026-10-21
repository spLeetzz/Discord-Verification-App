import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { EVENTS, enabledEvents } from "../../config/events.js";
import { countVerified } from "../../repo/sheet.js";
import type { Command } from "../../types/command.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const command: Command = {
  staffOnly: true,
  ephemeral: false,
  data: new SlashCommandBuilder()
    .setName("count")
    .setDescription("Display verified registration counts for all events.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    try {
      const stats: { name: string; count: number; status: string }[] = [];
      let totalVerified = 0;

      for (const eventKey of enabledEvents()) {
        const cfg = EVENTS[eventKey];
        const count = countVerified(eventKey);

        stats.push({ name: cfg.displayName, count, status: "OK" });
        totalVerified += count;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏆 Verified Registration Counts")
        .setColor(0x229db7)
        .setTimestamp()
        .setFooter({ text: "Based on current in-memory cache" });

      const descriptionLines = stats.map((s) => {
        const statusIcon = s.status === "OK" ? "✅" : "⚠️";
        return `**${s.name}**: ${s.count} ${statusIcon}${s.status !== "OK" ? ` (${s.status})` : ""}`;
      });

      descriptionLines.push(
        `\n**Total Verified Across All Events**: ${totalVerified}`,
      );

      embed.setDescription(descriptionLines.join("\n"));

      const channel = interaction.channel;

      if (!channel || !("send" in channel)) {
        await interaction.editReply({
          content: "❌ This channel cannot receive messages.",
        });
        return;
      }

      await channel.send({ embeds: [embed] });
      await interaction.deleteReply();
    } catch (err) {
      logger.error(`[CountCommand] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: "❌ An error occurred while calculating registration counts.",
      });
    }
  },
};

export default command;
