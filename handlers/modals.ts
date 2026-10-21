import { ChannelType } from "discord.js";
import type { ModalSubmitInteraction } from "discord.js";
import { EVENTS, isEventKey } from "../config/events.js";
import { findParticipant, isEmailVerified } from "../repo/sheet.js";
import type { TicketSubmission } from "../types/ticket.js";
import { errorMessage } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { createVerificationThread } from "../utils/thread.js";
import { validateSubmission } from "../utils/validation.js";

export async function handleModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [type, eventKey] = interaction.customId.split(":");

  if (type !== "verify_modal") return;

  if (!eventKey || !isEventKey(eventKey)) {
    // Note: Since we globally defer, we must use editReply here
    await interaction.editReply({ content: "Unknown event." });
    return;
  }

  const cfg = EVENTS[eventKey];

  const raw: Record<string, string> = {};

  for (const field of cfg.modalFields) {
    raw[field.id] = interaction.fields.getTextInputValue(field.id);
  }

  const validation = validateSubmission(cfg.modalFields, raw);

  if (!validation.ok) {
    await interaction.editReply({ content: validation.message });
    return;
  }

  const submission: TicketSubmission = {
    name: validation.values.name ?? "",
    email: validation.values.email ?? "",
    phone: validation.values.phone,
    chessRating: validation.values.chess_rating,
  };

  // Layer 2 of the duplicate rule: this registration email is already
  // verified for the event.
  if (isEmailVerified(eventKey, submission.email)) {
    await interaction.editReply({
      content: `❌ **${submission.email}** has already been verified for ${cfg.displayName}.\n\nEach team can only be verified once. Please contact staff if this is a mistake.`,
    });
    return;
  }

  // Only the original flow looks the registration up in a sheet.
  const result =
    cfg.mode === "sheet-lookup"
      ? findParticipant(eventKey, submission.email)
      : { status: "not_found" as const, rows: [] };

  if (result.status === "duplicate") {
    await interaction.editReply({
      content: `⚠️ Multiple registrations found for ${submission.email} in ${cfg.displayName}.\n\nPlease contact staff to remove the duplicate entry before opening a verification ticket.`,
    });
    return;
  }

  const channel = interaction.channel;

  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply({
      content: "I could not find the verification channel. Please contact staff.",
    });
    return;
  }

  try {
    const thread = await createVerificationThread(
      channel,
      interaction.user,
      eventKey,
      submission,
      result,
    );

    await interaction.editReply({
      content: `Your verification ticket has been created: ${thread.url}`,
    });
  } catch (err) {
    logger.error(`[Modal] Failed to create ticket: ${errorMessage(err)}`);
    await interaction.editReply({
      content:
        "Something went wrong creating your ticket. Please contact staff.",
    });
  }
}
