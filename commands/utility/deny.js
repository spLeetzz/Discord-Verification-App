import { logger } from "../../utils/logger.js";
import { SlashCommandBuilder, ChannelType } from "discord.js";
import { updateThreadStatus } from "../../utils/thread.js";


export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("deny")
    .setDescription("Mark the current verification ticket as denied.")
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Optional reason to send to the participant."),
    ),

  async execute(interaction) {
    const thread = interaction.channel;

    if (thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification ticket.",
      });
    }

    try {
      const reason = interaction.options.getString("reason");

      await updateThreadStatus(thread, "❌");


      const pins = await thread.messages.fetchPins();
      const pinnedMsg = pins
        .map((p) => p)
        .find((m) => m.author.id === interaction.client.user.id);

      const member = pinnedMsg?.mentions.members?.first();
      const name = member ? `${member}` : "there";

      const msg = reason
        ? `Hi ${name}, your verification has been **denied**.\nReason: ${reason}`
        : `Hi ${name}, your verification has been **denied**. Please contact staff if you have questions.`;


      await thread.send(msg);
      await interaction.editReply({ content: "Done." });
    } catch (err) {
      logger.error("[Deny] Error:", err);
      await interaction.editReply({
        content: `An error occurred: ${err.message}`,
      });
    }
  },
};
