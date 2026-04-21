import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import { findParticipant } from "../../repo/sheet.js";
import { buildPinnedContent } from "../../utils/embeds.js";


export default {
  staffOnly: true,
  data: new SlashCommandBuilder()
    .setName("setemail")
    .setDescription(
      "Update the registration email linked to this verification ticket.",
    )
    .addStringOption((opt) =>
      opt
        .setName("email")
        .setDescription("The correct registered email address")
        .setRequired(true),
    ),

  async execute(interaction) {
    const thread = interaction.channel;

    if (thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification thread.",
      });
    }

    const eventEntry = getEventByChannelId(thread.parentId);
    if (!eventEntry) {
      return interaction.editReply({
        content: "This ticket is not inside a recognised verification channel.",
      });
    }
    const [eventKey, cfg] = eventEntry;

    const email = interaction.options.getString("email").trim();
    const result = findParticipant(cfg.sheetName, email);

    if (result.status === "not_found") {
      return interaction.editReply({
        content: `❌ **${email}** not found in the ${cfg.displayName} sheet.\nDouble-check the email or wait for the next sheet sync (every 60s).`,
      });
    }

    if (result.status === "duplicate") {
      return interaction.editReply({
        content: `⚠️ **${email}** has duplicate entries in the sheet.\n Remove duplicate entries before this email can be set.`,
      });
    }

    const pins = await thread.messages.fetchPins();
    const pinnedMsg = pins.find((m) => m.author.id === interaction.client.user.id);

    if (!pinnedMsg) {
      return interaction.editReply({
        content: "Could not find the bot's pinned message in this ticket.",
      });
    }

    const member = pinnedMsg.mentions.members?.first();
    const user = member?.user ?? { toString: () => "Unknown" };

    // Edit pinned message with refreshed registration details
    const newContent = buildPinnedContent(user, eventKey, email, result);
    await pinnedMsg.edit(newContent);

    await interaction.editReply({
      content: `✅ Email updated to **${email}**. Registration details refreshed in the pinned message.`,
    });
  },
};
