import { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { logger } from "../../utils/logger.js";

export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("fetch_threads")
    .setDescription("Get all threads in a channel sorted alphabetically.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The text channel to fetch threads from.")
        .setRequired(true),
    ),

  async execute(interaction) {
    const channel = interaction.options.getChannel("channel");

    if (channel.type !== ChannelType.GuildText) {
      return interaction.editReply({
        content: "Please select a standard text channel.",
      });
    }

    try {

      const activeThreads = [...channel.threads.cache.values()];

      const archivedPublic = await channel.threads.fetchArchived({
        type: "public",
        fetchAll: true,
      });

      const archivedPrivate = await channel.threads.fetchArchived({
        type: "private",
        fetchAll: true,
      });

      const allThreads = [
        ...activeThreads,
        ...archivedPublic.threads.values(),
        ...archivedPrivate.threads.values(),
      ];

      const seen = new Set();
      const unique = [];
      for (const t of allThreads) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          unique.push(t);
        }
      }

      const sorted = unique.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );

      if (sorted.length === 0) {
        return interaction.editReply({
          content: "No threads found in that channel.",
        });
      }

      const lines = [
        `**Threads in <#${channel.id}> (sorted alphabetically):**\n`,
        ...sorted.map(
          (t) =>
            `- [${t.name}](https://discord.com/channels/${interaction.guildId}/${t.id})`,
        ),
      ];

      const chunks = [];
      let chunk = "";
      for (const line of lines) {
        if (chunk.length + line.length + 1 > 2000) {
          chunks.push(chunk.trimEnd());
          chunk = line + "\n";
        } else {
          chunk += line + "\n";
        }
      }
      if (chunk) chunks.push(chunk.trimEnd());

      await interaction.editReply({ content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
          content: chunks[i],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      logger.error("[FetchThreads] Error:", err);
      await interaction.editReply({
        content: "An error occurred while fetching threads.",
      });
    }
  },
};
