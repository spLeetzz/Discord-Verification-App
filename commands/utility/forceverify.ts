import { ChannelType, SlashCommandBuilder, TextChannel } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import type { Command } from "../../types/command.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { forwardMedia, updateThreadStatus } from "../../utils/thread.js";

const command: Command = {
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

    if (!thread || thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification ticket.",
      });
    }

    const guild = interaction.guild;

    if (!guild) {
      return interaction.editReply({
        content: "This command can only be used inside a server.",
      });
    }

    const parentId = thread.parentId;

    if (!parentId) {
      return interaction.editReply({
        content: "This ticket is not inside a recognised verification channel.",
      });
    }

    const eventEntry = getEventByChannelId(parentId);

    if (!eventEntry) {
      return interaction.editReply({
        content: "This ticket is not inside a recognised verification channel.",
      });
    }

    const [, cfg] = eventEntry;

    // Direct-registration events have no pre-existing sheet row to bypass.
    // Every verification there is a sheet append, so /forceverify is off.
    if (cfg.mode === "direct-registration") {
      return interaction.editReply({
        content: `⚠️ \`/forceverify\` is not available for **${cfg.displayName}**.\n\nEvery verification there writes a row to the sheet, so use \`/verify\` instead.`,
      });
    }

    try {
      const user = interaction.options.getUser("user");

      if (!user) {
        return interaction.editReply({
          content: "Could not find that user in this server.",
        });
      }

      const member = await guild.members
        .fetch(user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply({
          content: "Could not find that user in this server.",
        });
      }

      const role = guild.roles.cache.get(cfg.roleId);

      if (role) {
        await member.roles.add(role);
      } else {
        logger.warn(`[ForceVerify] Role ${cfg.roleId} not found.`);
      }

      const backupChannel = guild.channels.cache.get(cfg.backupChannelId);

      if (backupChannel instanceof TextChannel) {
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
      logger.error(`[ForceVerify] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: `An error occurred: ${errorMessage(err)}`,
      });
    }
  },
};

export default command;
