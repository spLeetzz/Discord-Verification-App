/**
 * The guards of the identity area.
 *
 * The screenshot-verification panel is a **control panel**: its buttons
 * delete a server's verification setup, repoint the channel the bot reads
 * the screenshots in, change the role the bot grants on success, and set
 * the text and the link the bot posts afterwards. It is opened by a
 * moderator, but the panel is a **message** — anybody who can read the
 * channel it is in can see it and press its buttons.
 *
 * So the panel checks the caller itself. That is the rule the rest of the
 * repository already follows: the slots area says it outright ("the panel
 * is public, so the buttons check the caller themselves"), the tourneys
 * area calls `refuseUnlessMod`, and the moderation area calls `isStaff`.
 * This area did not, and that was the hole.
 *
 * ## The rule
 *
 * A caller may manage a screenshot-verification setup when **both** hold:
 *
 *  1. **the caller is a moderator of the guild the setup belongs to** —
 *     Manage Server, Administrator, or the staff role this guild already
 *     uses; and
 *  2. **the setup belongs to the guild the interaction came from**.
 *
 * The first half is decided here. The second half is decided by the
 * **lookup**: every read and every write of a setup is keyed by the guild
 * *and* the row id (`repo.findSsConfigById(guildId, id)` and its
 * neighbours), so a row of another server is not found and cannot be
 * written. A uuid primary key makes a cross-guild guess unguessable, not
 * impossible — that is not a defence, so the lookup carries the guild.
 *
 * D28: a guard answers "may this caller do this?" and returns `null` to
 * allow, or the refusal to show. A guard never throws past the handler.
 */

import { PermissionFlagsBits } from "discord.js";
import type { RepliableInteraction } from "discord.js";
import { isStaff } from "../../core/guards.js";
import { getGuildMember } from "../../utils/member.js";

/**
 * The refusal a caller who may not manage the setups gets.
 *
 * The command that opens the panel needs **Manage Server**, and the staff
 * role is the one this guild already uses for its staff commands, so both
 * are named.
 */
export const SSMOD_DENIAL_MESSAGE =
  "You need the **Manage Server** permission or the **Moderator** role to manage screenshot verification.";

/**
 * May the caller manage the screenshot-verification setups of this guild?
 *
 * @param interaction the interaction to check.
 * @param guildId     the guild whose setups the caller is trying to manage.
 *                    The interaction must come from that guild.
 * @returns `null` when they may, the refusal message when they may not.
 */
export async function canManageSsConfig(
  interaction: RepliableInteraction,
  guildId: string | null,
): Promise<string | null> {
  if (!guildId) {
    return "This only works in a server.";
  }

  const guild = interaction.guild;

  if (!guild) {
    return "This only works in a server.";
  }

  // The interaction must come from the guild whose setups are being
  // managed. A button cannot be pressed in one server and act on another.
  if (guild.id !== guildId) {
    return "That setup belongs to another server.";
  }

  const member = await getGuildMember(interaction);

  if (!member) {
    return SSMOD_DENIAL_MESSAGE;
  }

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  // The staff role this guild already uses.
  if (await isStaff(interaction)) return null;

  return SSMOD_DENIAL_MESSAGE;
}
