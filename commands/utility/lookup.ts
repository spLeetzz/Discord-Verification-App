import { SlashCommandBuilder } from "discord.js";
import { EVENTS } from "../../config/events.js";
import { describeRow, findAcrossAll } from "../../repo/sheet.js";
import type { Command } from "../../types/command.js";

const command: Command = {
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
    const email = interaction.options.getString("email")?.trim();

    if (!email) {
      return interaction.editReply({
        content: "❌ Please provide a valid email address.",
      });
    }

    const results = findAcrossAll(email);

    if (results.length === 0) {
      return interaction.editReply({
        content: "No events are currently open for lookup.",
      });
    }

    const lines = results.map(({ eventKey, status, rows }) => {
      const cfg = EVENTS[eventKey];

      if (status === "not_found") {
        return `❌ **${cfg.displayName}**: Not found`;
      }

      if (status === "duplicate") {
        return `⚠️ **${cfg.displayName}**: ${rows.length} duplicate entries`;
      }

      const row = rows[0];
      if (!row) {
        return `⚠️ **${cfg.displayName}**: Found but empty`;
      }

      return `✅ **${cfg.displayName}**: ${describeRow(eventKey, row)}`;
    });

    await interaction.editReply({
      content: `**Lookup:** \`${email}\`\n\n${lines.join("\n")}`,
    });
  },
};

export default command;
