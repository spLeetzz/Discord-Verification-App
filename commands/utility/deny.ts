import { ChannelType, SlashCommandBuilder } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import { removeParticipant } from "../../repo/sheet.js";
import type { Command } from "../../types/command.js";
import { parsePinnedField } from "../../utils/embeds.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { withLock } from "../../utils/lock.js";
import { updateThreadStatus } from "../../utils/thread.js";

const command: Command = {
  staffOnly: true,
  ephemeral: true,
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

    try {
      const pins = await thread.messages.fetchPins();
      const pinnedMsg = pins.items.find(
        (m) => m.message.author.id === interaction.client.user.id,
      )?.message;

      if (!pinnedMsg) {
        return interaction.editReply({
          content: "No pinned message found in this thread.",
        });
      }

      const parentId = thread.parentId;
      const eventEntry = parentId
        ? getEventByChannelId(parentId)
        : undefined;

      if (!eventEntry) {
        return interaction.editReply({
          content: "This ticket is not inside a recognised verification channel.",
        });
      }

      const [eventKey, cfg] = eventEntry;
      const email = parsePinnedField(pinnedMsg.content, "Email");
      const mentioned = pinnedMsg.mentions.members?.first();
      const user = pinnedMsg.mentions.users.first();
      const member = user
        ? await guild.members.fetch(user.id).catch(() => null)
        : null;

      // One command, one locked region: the sheet, the role and the thread
      // all end up agreeing, whatever else staff are doing at the time.
      const summary = await withLock(eventKey, async () => {
        const notes: string[] = [];

        // 1. Take the team out of the sheet.
        if (email) {
          const removal = await removeParticipant(eventKey, email);

          if (removal.status === "removed") {
            notes.push(`Removed ${removal.removed} row(s) from the sheet.`);
          }
        }

        // 2. Take the verified role back, if they were given it.
        if (member) {
          const role = guild.roles.cache.get(cfg.roleId);

          if (role && member.roles.cache.has(role.id)) {
            await member.roles.remove(role);
            notes.push(`Removed the ${role.name} role.`);
          }
        }

        // 3. Mark the ticket.
        await updateThreadStatus(thread, "❌");

        return notes;
      });

      const member2 = mentioned ? `${mentioned}` : "there";

      const reason = interaction.options.getString("reason");

      const msg = reason
        ? `Hi ${member2}, your verification has been **denied**.\nReason: ${reason}`
        : `Hi ${member2}, your verification has been **denied**. Please contact staff if you have questions.`;

      await thread.send(msg);

      await interaction.editReply({
        content: summary.length
          ? `Done. ${summary.join(" ")}`
          : "Done.",
      });
    } catch (err) {
      logger.error(`[Deny] Error: ${errorMessage(err)}`);
      await interaction.editReply({
        content: `An error occurred: ${errorMessage(err)}`,
      });
    }
  },
};

export default command;
