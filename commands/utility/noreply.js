import { logger } from "../../utils/logger.js";
import { SlashCommandBuilder, ChannelType } from "discord.js";
import { updateThreadStatus } from "../../utils/thread.js";

export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("noreply")
    .setDescription("Flag the current verification ticket as no response."),

  async execute(interaction) {
    const thread = interaction.channel;

    if (thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification ticket.",
      });
    }

    try {
      await updateThreadStatus(thread, "❗");
      await interaction.editReply({ content: "Done." });
    } catch (err) {
      logger.error("[NoReply] Error:", err);
      await interaction.editReply({
        content: `An error occurred: ${err.message}`,
      });
    }
  },
};

