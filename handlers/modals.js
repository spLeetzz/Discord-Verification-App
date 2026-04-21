import { findParticipant } from "../repo/sheet.js";
import { createVerificationThread } from "../utils/thread.js";
import { EVENTS } from "../config/events.js";
import { MessageFlags } from "discord.js";

export async function handleModal(interaction) {
  const [type, eventKey] = interaction.customId.split(":");

  if (type !== "verify_modal") return;

  const cfg = EVENTS[eventKey];
  if (!cfg) {
    // Note: Since we globally defer, we must use editReply here
    await interaction.editReply({
      content: "Unknown event.",
    });
    return;
  }


  const email = interaction.fields.getTextInputValue("email").trim();
  const name = interaction.fields.getTextInputValue("name").trim();
  const result = findParticipant(cfg.sheetName, email);

  if (result.status === "duplicate") {
    await interaction.editReply({
      content: `⚠️ Multiple registrations found for ${email} in ${cfg.displayName}.\n\nPlease contact staff to remove the duplicate entry before opening a verification ticket.`,
    });
    return;
  }

  try {
    const thread = await createVerificationThread(
      interaction,
      interaction.user,
      eventKey,
      email,
      name,
      result,
    );

    await interaction.editReply({
      content: `Your verification ticket has been created: ${thread.url}`,
    });
  } catch (err) {
    console.error("[Modal] Failed to create ticket:", err);
    await interaction.editReply({
      content:
        "Something went wrong creating your ticket. Please contact staff.",
    });
  }
}
