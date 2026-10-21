import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const command: Command = {
  staffOnly: true,
  ephemeral: false,
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

    if (!(channel instanceof TextChannel)) {
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

      const seen = new Set<string>();
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

      const guildId = interaction.guildId;

      const renderName = (name: string): string => {
        const first = name[0];
        if (first === "✅" || first === "❌" || first === "❗") {
          return `${first} [${name.slice(1).trimStart()}]`;
        }
        return `[${name}]`;
      };

      const lines = [
        `**Threads in <#${channel.id}> (sorted alphabetically):**\n`,
        ...sorted.map(
          (t) =>
            `- ${renderName(t.name)}(https://discord.com/channels/${guildId}/${t.id})`,
        ),
      ];

      const chunks: string[] = [];
      let chunk = "";

      for (const line of lines) {
        if (chunk.length + line.length + 1 > 2000) {
          chunks.push(chunk.trimEnd());
          chunk = `${line}\n`;
        } else {
          chunk += `${line}\n`;
        }
      }

      if (chunk) chunks.push(chunk.trimEnd());

      const target = interaction.channel;

      if (!target || !("send" in target)) {
        await interaction.editReply({
          content: "❌ This channel cannot receive messages.",
        });
        return;
      }

      await target.send({ content: chunks[0] });

      for (let i = 1; i < chunks.length; i++) {
        const part = chunks[i];
        if (!part) continue;
        await target.send({ content: part });
      }

      await interaction.deleteReply();
    } catch (err) {
      logger.error(`[FetchThreads] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: "An error occurred while fetching threads.",
      });
    }
  },
};

export default command;
