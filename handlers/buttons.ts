import { MessageFlags } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import { EVENTS, isEventKey } from "../config/events.js";
import { registerLegacyVerifyButton, dispatch } from "../core/router.js";
import { isDiscordVerified } from "../repo/sheet.js";
import { buildVerificationModal } from "../utils/embeds.js";
import { isIgnorableInteractionError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getGuildMember } from "../utils/member.js";

/**
 * The frozen verification button.
 *
 * `verify_btn:<eventKey>` is the one custom id that predates the router, and
 * `verify_btn` is not a module name — so it gets an explicit branch rather
 * than being treated as a module prefix (D7, D11). The behaviour below is
 * unchanged from before the port.
 */
async function handleVerificationButton(
  interaction: ButtonInteraction,
  eventKey: string | null,
): Promise<void> {
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

registerLegacyVerifyButton(handleVerificationButton);

/**
 * Routes a button.
 *
 * The router dispatches on the custom id's prefix and **never guesses**: an
 * id whose prefix nobody registered is logged and refused politely.
 */
export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  await dispatch(interaction);
}
