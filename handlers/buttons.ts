import { MessageFlags } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import { EVENTS, isEventKey } from "../config/events.js";
import { isDiscordVerified } from "../repo/sheet.js";
import { buildVerificationModal } from "../utils/embeds.js";
import { isIgnorableInteractionError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getGuildMember } from "../utils/member.js";

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const [type, eventKey] = interaction.customId.split(":");

  if (type !== "verify_btn") return;

  if (!eventKey || !isEventKey(eventKey)) {
    await interaction.reply({
      content: "Unknown event. Please contact staff.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cfg = EVENTS[eventKey];
  const roleId = cfg.roleId;

  // Layer 1 of the duplicate rule: this Discord account already holds the
  // event's verified role.
  if (roleId) {
    const member = await getGuildMember(interaction);

    if (member?.roles.cache.has(roleId)) {
      await interaction.reply({
        content: `You have already completed ${cfg.displayName}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // The same account, verified before the role was granted (or the role was
  // removed by accident) is still blocked.
  if (isDiscordVerified(eventKey, interaction.user.id)) {
    await interaction.reply({
      content: `You are already verified for **${cfg.displayName}**. You cannot register again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.showModal(buildVerificationModal(eventKey));
  } catch (err) {
    // 10062 = Unknown Interaction (Expired)
    // 40060 = Interaction already acknowledged (Double-click)
    if (!isIgnorableInteractionError(err)) throw err;
    logger.debug(`[Button] Ignored modal open race for ${eventKey}.`);
  }
}
