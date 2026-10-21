import { ChannelType, SlashCommandBuilder } from "discord.js";
import { getEventByChannelId } from "../../config/events.js";
import { findParticipant, isEmailVerified } from "../../repo/sheet.js";
import type { Command } from "../../types/command.js";
import { buildPinnedContent, parsePinnedField } from "../../utils/embeds.js";

const command: Command = {
  staffOnly: true,
  ephemeral: true,
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

    if (!thread || thread.type !== ChannelType.PrivateThread) {
      return interaction.editReply({
        content: "This command can only be used inside a verification thread.",
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

    const [eventKey, cfg] = eventEntry;

    const email = interaction.options.getString("email")?.trim().toLowerCase();

    if (!email) {
      return interaction.editReply({
        content: "❌ Please provide a valid email address.",
      });
    }

    const pins = await thread.messages.fetchPins();
    const pinnedMsg = pins.items.find(
      (m) => m.message.author.id === interaction.client.user.id,
    )?.message;

    if (!pinnedMsg) {
      return interaction.editReply({
        content: "Could not find the bot's pinned message in this ticket.",
      });
    }

    const member = pinnedMsg.mentions.members?.first();
    const user = member?.user ?? { toString: () => "Unknown" };

    // --- Direct registration (Free Fire) -------------------------------
    // The email becomes a sheet column, so make sure it does not point at a
    // registration that is already verified.
    if (cfg.mode === "direct-registration") {
      if (isEmailVerified(eventKey, email)) {
        return interaction.editReply({
          content: `⚠️ **${email}** has already been verified for ${cfg.displayName}.\n\nEach team can only be verified once, so this email cannot be used.`,
        });
      }

      const teamName = parsePinnedField(pinnedMsg.content, "Team Name") ?? "";
      const phone = parsePinnedField(pinnedMsg.content, "Phone") ?? "";

      const newContent = buildPinnedContent(
        user,
        eventKey,
        { name: teamName, email, phone },
        { status: "not_found", rows: [] },
      );

      await pinnedMsg.edit(newContent);

      await interaction.editReply({
        content: `✅ Email updated to **${email}**. Registration details refreshed in the pinned message.`,
      });
      return;
    }

    // --- Sheet lookup (the original flow) ------------------------------
    const result = findParticipant(eventKey, email);

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

    let chessRating: string | undefined;

    if (eventKey === "Chess") {
      chessRating = parsePinnedField(pinnedMsg.content, "Chess.com Rating");
    }

    // Edit pinned message with refreshed registration details
    const newContent = buildPinnedContent(
      user,
      eventKey,
      { name: "", email, chessRating },
      result,
    );
    await pinnedMsg.edit(newContent);

    await interaction.editReply({
      content: `✅ Email updated to **${email}**. Registration details refreshed in the pinned message.`,
    });
  },
};

export default command;
