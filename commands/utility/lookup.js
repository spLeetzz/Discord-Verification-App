import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { findAcrossAll } from "../../repo/sheet.js";
import { EVENTS } from "../../config/events.js";

export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("lookup")
    .setDescription("Look up a registration email across all event sheets.")
    .addStringOption((opt) =>
      opt
        .setName("email")
        .setDescription("Email address to look up")
        .setRequired(true),
    ),

  async execute(interaction) {
    const email = interaction.options.getString("email").trim();

    const results = findAcrossAll(email);

    const lines = results.map(({ eventKey, status, rows }) => {
      const cfg = EVENTS[eventKey];

      if (status === "not_found") {
        return `❌ **${cfg.displayName}**: Not found`;
      }

      if (status === "duplicate") {
        return `⚠️ **${cfg.displayName}**: ${rows.length} duplicate entries`;
      }

      // unique
      const row = rows[0];
      const detail = cfg.isTeamEvent
        ? `Team: ${row[3] || "N/A"} | Captain: ${row[4] || "N/A"} | DOB: ${row[6] || "N/A"}`
        : `Name: ${row[3] || "N/A"} | DOB: ${row[5] || "N/A"}`;

      return `✅ **${cfg.displayName}**: ${detail}`;
    });

    await interaction.editReply({
      content: `**Lookup:** \`${email}\`\n\n${lines.join("\n")}`,
    });
  },
};
