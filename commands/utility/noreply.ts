import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/command.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { updateThreadStatus } from "../../utils/thread.js";

const command: Command = {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("noreply")
    .setDescription("Flag the current verification ticket as no response."),

  async execute(interaction) {
    const thread = interaction.channel;

    if (!thread || thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification ticket.",
      });
    }

    try {
      await updateThreadStatus(thread, "❗");
      await interaction.editReply({ content: "Done." });
    } catch (err) {
      logger.error(`[NoReply] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: `An error occurred: ${errorMessage(err)}`,
      });
    }
  },
};

export default command;
