import { logger } from "../../utils/logger.js";
import { SlashCommandBuilder, ChannelType } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import { forwardMedia, updateThreadStatus } from "../../utils/thread.js";


export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("forceverify")
    .setDescription(
      "Manually verify a user, bypassing sheet and pinned message checks.",
    )
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("The participant to verify")
        .setRequired(true),
    ),

  async execute(interaction) {
    const thread = interaction.channel;

    if (thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification ticket.",
      });
    }

    const eventEntry = getEventByChannelId(thread.parentId);
    if (!eventEntry) {
      return interaction.editReply({
        content: "This ticket is not inside a recognised verification channel.",
      });
    }
    const [, cfg] = eventEntry;

    try {

      const member = interaction.options.getMember("user");
      if (!member) {
        return interaction.editReply({
          content: "Could not find that user in this server.",
        });
      }

      const role = interaction.guild.roles.cache.get(cfg.roleId);
      if (role) {
        await member.roles.add(role);
      } else {
        logger.warn(`[ForceVerify] Role ${cfg.roleId} not found.`);
      }

      const backupChannel = interaction.guild.channels.cache.get(
        cfg.backupChannelId,
      );
      if (backupChannel) {
        await forwardMedia(
          thread,
          backupChannel,
          `✅ Force-verified by ${interaction.user}`,
        );
      }

      await updateThreadStatus(thread, "✅");

      await thread.send(
        `✅ ${member} has been verified in this ticket by ${interaction.user}.\n⚠️ Sheet has not been updated, staff should update it manually.`,
      );

      await interaction.editReply({ content: "Done." });
    } catch (err) {
      logger.error("[ForceVerify] Error:", err);
      await interaction.editReply({
        content: `An error occurred: ${err.message}`,
      });
    }
  },
};
