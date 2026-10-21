import { ChannelType, SlashCommandBuilder, TextChannel } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import {
  appendParticipant,
  isDiscordVerified,
  isEmailVerified,
  verifyParticipant,
} from "../../repo/sheet.js";
import type { Command } from "../../types/command.js";
import { parsePinnedField } from "../../utils/embeds.js";
import { DenialError, errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { withLock } from "../../utils/lock.js";
import { forwardMedia, updateThreadStatus } from "../../utils/thread.js";

const command: Command = {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Mark the current verification ticket as verified."),

  async execute(interaction) {
    const thread = interaction.channel;

    if (!thread || thread.type !== ChannelType.PrivateThread) {
      // Note: Since we globally defer, we must use editReply here
      return interaction.editReply({
        content: "This command can only be used inside a verification thread.",
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
        content: "This thread is not inside a recognised verification channel.",
      });
    }

    const eventEntry = getEventByChannelId(parentId);

    if (!eventEntry) {
      return interaction.editReply({
        content: "This thread is not inside a recognised verification channel.",
      });
    }

    const [eventKey, cfg] = eventEntry;

    try {
      const pins = await thread.messages.fetchPins();
      const pinnedMsg = pins.items.find(
        (m) => m.message.author.id === interaction.client.user.id,
      )?.message;

      if (!pinnedMsg) {
        return interaction.editReply({
          content: "Could not find the bot's pinned message in this ticket.",
        });
      }

      const email = parsePinnedField(pinnedMsg.content, "Email");

      if (!email) {
        return interaction.editReply({
          content:
            "Could not parse email from the pinned message. Use `/setemail` to fix it.",
        });
      }

      const user = pinnedMsg.mentions.users.first();

      if (!user) {
        return interaction.editReply({
          content: "Could not find a user mention in the pinned message.",
        });
      }

      const member = await guild.members
        .fetch(user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply({
          content: "Could not fetch member, they may have left the server.",
        });
      }

      /**
       * The sheet, the role and the thread are all changed together, under
       * the event lock, so a /deny running at the same time cannot
       * interleave and leave them disagreeing.
       */
      await withLock(eventKey, async () => {
        if (cfg.mode === "direct-registration") {
          // There is no pre-existing sheet row. Verify re-checks the
          // duplicate rule, then appends the team.
          if (isEmailVerified(eventKey, email)) {
            throw new DenialError(
              `❌ **${email}** has already been verified for ${cfg.displayName}. Each team can only be verified once.`,
            );
          }

          if (isDiscordVerified(eventKey, member.id)) {
            throw new DenialError(
              `❌ This Discord account has already been verified for ${cfg.displayName}. Each account can only be verified once.`,
            );
          }

          const teamName =
            parsePinnedField(pinnedMsg.content, "Team Name") ?? "";
          const phone = parsePinnedField(pinnedMsg.content, "Phone") ?? "";

          const append = await appendParticipant(eventKey, {
            teamName,
            email,
            phone,
            discordId: member.id,
            threadLink: thread.url,
          });

          if (append.status === "missing_columns") {
            throw new DenialError(
              `⚠️ Sheet "${cfg.sheetName}" is missing required columns.`,
            );
          }
        } else {
          // Sheet lookup: the team was already in the sheet, so verify
          // marks that same row.
          const sheetResult = await verifyParticipant(eventKey, email, {
            staffName: interaction.user.tag,
            discordId: member.id,
            threadLink: thread.url,
          });

          switch (sheetResult.status) {
            case "already_verified":
              throw new DenialError(
                `ℹ️ ${email} is already marked as verified in the sheet.`,
              );
            case "not_found":
              throw new DenialError(`❌ ${email} not found in the sheet.`);
            case "duplicate":
              throw new DenialError(
                `⚠️ Duplicate entries for ${email} in the sheet. Clean it up first.`,
              );
            case "missing_columns":
              throw new DenialError(
                `⚠️ Sheet "${cfg.sheetName}" is missing required columns.`,
              );
            case "ok":
              break;
          }
        }

        // Grant the role.
        const role = guild.roles.cache.get(cfg.roleId);

        if (role) {
          await member.roles.add(role);
        } else {
          logger.warn(`[Verify] Role ${cfg.roleId} not found in guild.`);
        }

        // Mark the ticket.
        await updateThreadStatus(thread, "✅");
        await thread.send(
          `Hi ${member}! Your verification is complete ✅. Please keep an eye on the event updates channel for further details.`,
        );
      });

      await interaction.editReply({ content: "Done." });

      const backupChannel = guild.channels.cache.get(cfg.backupChannelId);

      if (backupChannel instanceof TextChannel) {
        setImmediate(async () => {
          try {
            await forwardMedia(
              thread,
              backupChannel,
              `✅ Verified by ${interaction.user}`,
            );
          } catch (err) {
            logger.error(
              `[Verify] Background backup failed: ${errorMessage(err)}`,
            );
          }
        });
      }
    } catch (err) {
      if (err instanceof DenialError) {
        await interaction.editReply({ content: err.message });
        return;
      }

      logger.error(`[Verify] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: `An error occurred: ${errorMessage(err)}`,
      });
    }
  },
};

export default command;
