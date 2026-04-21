import { logger } from "../../utils/logger.js";
import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import { forwardMedia, updateThreadStatus } from "../../utils/thread.js";
import { verifyParticipant } from "../../repo/sheet.js";


export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Mark the current verification ticket as verified."),

  async execute(interaction) {
    const thread = interaction.channel;

    if (thread.type !== ChannelType.PrivateThread) {
      // Note: Since we globally defer, we must use editReply here
      return interaction.editReply({
        content: "This command can only be used inside a verification thread.",
      });
    }


    const eventEntry = getEventByChannelId(thread.parentId);
    if (!eventEntry) {
      return interaction.editReply({
        content: "This thread is not inside a recognised verification channel.",
      });
    }
    const [, cfg] = eventEntry;

    try {
      // Get the bot's pinned message to read email + participant mention
      const pins = await thread.messages.fetchPins();
      const pinnedMsg = pins.find((m) => m.author.id === interaction.client.user.id);
      if (!pinnedMsg) {
        return interaction.editReply({
          content: "No pinned message found in this thread.",
        });
      }

      // Parse email from pinned content
      const emailMatch = pinnedMsg.content.match(/\*\*Email:\*\* (.+)/);
      if (!emailMatch) {
        return interaction.editReply({
          content:
            "Could not parse email from the pinned message. Use `/setemail` to fix it.",
        });
      }
      const email = emailMatch[1].trim();

      const user = pinnedMsg.mentions.users.first();
      if (!user) {
        return interaction.editReply({
          content: "Could not find a user mention in the pinned message.",
        });
      }
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      if (!member) {
        return interaction.editReply({
          content: "Could not fetch member, they may have left the server.",
        });
      }

      const sheetResult = await verifyParticipant(cfg.sheetName, email, {
        staffName: interaction.user.tag,
        discordId: member.id,
        threadLink: thread.url,
      });

      if (sheetResult.status === "already_verified") {
        return interaction.editReply({
          content: `ℹ️ ${email} is already marked as verified in the sheet.`,
        });
      }
      if (sheetResult.status === "not_found") {
        return interaction.editReply({
          content: `❌ ${email} not found in the sheet.`,
        });
      }
      if (sheetResult.status === "duplicate") {
        return interaction.editReply({
          content: `⚠️ Duplicate entries for ${email} in the sheet. Clean it up first.`,
        });
      }
      if (sheetResult.status === "missing_columns") {
        return interaction.editReply({
          content: `⚠️ Sheet "${cfg.sheetName}" is missing required columns.`,
        });
      }


      // Assign role
      const role = interaction.guild.roles.cache.get(cfg.roleId);
      if (role) {
        await member.roles.add(role);
      } else {
        logger.warn(`[Verify] Role ${cfg.roleId} not found in guild.`);
      }

      const backupChannel = interaction.guild.channels.cache.get(
        cfg.backupChannelId,
      );

      await updateThreadStatus(thread, "✅");
      await thread.send(
        `Hi ${member}! Your verification is complete ✅. Please keep an eye on the event updates channel for further details.`,
      );

      await interaction.editReply({ content: "Done." });


      if (backupChannel) {
        setImmediate(async () => {
          try {
            await forwardMedia(thread, backupChannel);
            await backupChannel.send(
              `✅ Verified by ${interaction.user}\nThread: ${thread.url}`,
            );
          } catch (err) {
            logger.error("[Verify] Background backup failed:", err);
          }
        });
      }
    } catch (err) {
      logger.error("[Verify] Error:", err);
      await interaction.editReply({
        content: `An error occurred: ${err.message}`,
      });
    }
  },
};


