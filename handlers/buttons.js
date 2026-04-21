import { buildVerificationModal } from "../utils/embeds.js";
import { EVENTS } from "../config/events.js";
import { MessageFlags } from "discord.js";

export async function handleButton(interaction) {

  const [type, eventKey] = interaction.customId.split(":");

  if (type !== "verify_btn") return;

  if (!EVENTS[eventKey]) {
    await interaction.reply({
      content: "Unknown event. Please contact staff.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const roleId = EVENTS[eventKey].roleId;
  if (roleId && interaction.member.roles.cache.has(roleId)) {
    await interaction.reply({
      content: `You have already completed ${EVENTS[eventKey].displayName}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildVerificationModal(eventKey)).catch((err) => {
    // 10062 = Unknown Interaction (Expired)
    // 40060 = Interaction already acknowledged (Double-click)
    if (err.code !== 10062 && err.code !== 40060) throw err;
  });

}
