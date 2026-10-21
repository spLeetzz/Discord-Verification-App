/**
 * The scrims guards.
 *
 * D28: a guard answers "may this caller do this?" and returns `null` to
 * allow or a string to refuse. Guards never throw past the handler.
 *
 * **A note on `canUseScrimMod`.** The brief for this area says the scrim
 * mod guard is `canUseScrimMod` in `core/guards.ts`. That function is not
 * in `core/guards.ts` yet — it is manager-owned and has not landed. The
 * local implementation below has the same shape and the same behaviour
 * the source had, so swapping it for the core one is a one-line change:
 * delete this function and import the core one instead.
 *
 * The source's rule was
 * `interaction.user.guild_permissions.manage_guild or "scrims-mod" in the
 * user's role names`. The role-name half is a name lookup, which D16
 * generally forbids — but the scrims mod role is a guild-wide
 * convention, not a per-scrim column, and there is nowhere in the schema
 * to store its id. It is kept, and it is *additive*: the existing
 * `Moderator` staff role and the Administrator permission also pass.
 */

import { PermissionFlagsBits } from "discord.js";
import type { Interaction, ModalSubmitInteraction } from "discord.js";
import { STAFF_DENIAL_MESSAGE, isStaff } from "../../core/guards.js";
import { getGuildMember } from "../../utils/member.js";

/** The name of the role the source used for scrim moderators. */
export const SCRIM_MOD_ROLE_NAME = "scrims-mod";

/** The refusal a non-moderator gets. */
export const SCRIM_MOD_DENIAL_MESSAGE =
  "You need the **scrims-mod** role or **Manage Server** permissions to use this command.";

/**
 * The interactions a scrims guard sees.
 *
 * A modal submit is not an `Interaction` in discord.js — it extends
 * `BaseInteraction` — so the union is spelled out here.
 */
export type ScrimsInteraction = Interaction | ModalSubmitInteraction;

/**
 * May the caller manage scrims?
 *
 * @returns `null` when they may, the refusal message when they may not.
 */
export async function canUseScrimMod(
  interaction: ScrimsInteraction,
): Promise<string | null> {
  const member = await getGuildMember(interaction as Interaction);

  if (!member) return SCRIM_MOD_DENIAL_MESSAGE;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  if (
    member.roles.cache.some(
      (role) => role.name.trim().toLowerCase() === SCRIM_MOD_ROLE_NAME,
    )
  ) {
    return null;
  }

  // The staff role this guild already uses.
  if (await isStaff(interaction as Interaction)) return null;

  return SCRIM_MOD_DENIAL_MESSAGE;
}

/**
 * The refusal the staff check gives.
 *
 * Re-exported so the scrims views have one place to read it from.
 */
export const STAFF_REFUSAL = STAFF_DENIAL_MESSAGE;
