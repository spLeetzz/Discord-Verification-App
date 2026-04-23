import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import cache from "../../repo/cache.js";
import { EVENTS } from "../../config/events.js";
import { logger } from "../../utils/logger.js";

export default {
  staffOnly: true,
  ephemeral: false,
  data: new SlashCommandBuilder()
    .setName("count")
    .setDescription("Display verified registration counts for all events.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    try {
      const stats = [];
      let totalVerified = 0;

      for (const [eventKey, cfg] of Object.entries(EVENTS)) {
        const rows = cache.get(cfg.sheetName);

        if (!rows || rows.length <= 1) {
          stats.push({
            name: cfg.displayName,
            count: 0,
            status: "No data in cache",
          });
          continue;
        }

        const headers = rows[0];
        const verifiedColIndex = headers.findIndex(
          (h) => h?.trim() === "Verified?",
        );

        if (verifiedColIndex === -1) {
          stats.push({
            name: cfg.displayName,
            count: 0,
            status: "Verified? column not found",
          });
          continue;
        }

        // Count rows where verifiedColIndex is "TRUE"
        let count = 0;
        for (let i = 1; i < rows.length; i++) {
          if (rows[i][verifiedColIndex]?.trim().toUpperCase() === "TRUE") {
            count++;
          }
        }

        stats.push({
          name: cfg.displayName,
          count: count,
          status: "OK",
        });
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

      await interaction.channel.send({ embeds: [embed] });
      await interaction.deleteReply();
    } catch (err) {
      logger.error("[CountCommand] Error:", err);
      await interaction.editReply({
        content: "❌ An error occurred while calculating registration counts.",
      });
    }
  },
};
