/**
 * The tournaments guards.
 *
 * D28: a guard answers "may this caller do this?" and returns `null` to
 * allow or a string to refuse. Guards never throw past the handler.
 *
 * The source's rule was
 * `interaction.user.guild_permissions.manage_guild or "tourney-mod" in the
 * user's role names`. The role-name half is a name lookup, which D16
 * generally forbids — but the tourney-mod role is a guild-wide
 * convention, not a per-tournament column, and there is nowhere in the
 * schema to store its id. It is kept, and it is *additive*: the existing
 * `Moderator` staff role and the Administrator permission also pass.
 */

import { PermissionFlagsBits } from "discord.js";
import type { Interaction, ModalSubmitInteraction } from "discord.js";
import { STAFF_DENIAL_MESSAGE, isStaff } from "../../core/guards.js";
import { getGuildMember } from "../../utils/member.js";

/** The name of the role the source used for tournament moderators. */
export const TOURNEY_MOD_ROLE_NAME = "tourney-mod";

/** The refusal a non-moderator gets. */
export const TOURNEY_MOD_DENIAL_MESSAGE =
  "You need the **tourney-mod** role or **Manage Server** permissions to use this command.";

/**
 * The interactions a tourneys guard sees.
 *
 * A modal submit is not an `Interaction` in discord.js — it extends
 * `BaseInteraction` — so the union is spelled out here.
 */
export type TourneysInteraction = Interaction | ModalSubmitInteraction;

/**
 * May the caller manage tournaments?
 *
 * @returns `null` when they may, the refusal message when they may not.
 */
export async function canUseTourneyMod(
  interaction: TourneysInteraction,
): Promise<string | null> {
  const member = await getGuildMember(interaction as Interaction);

  if (!member) return TOURNEY_MOD_DENIAL_MESSAGE;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  if (
    member.roles.cache.some(
      (role) => role.name.trim().toLowerCase() === TOURNEY_MOD_ROLE_NAME,
    )
  ) {
    return null;
  }

  // The staff role this guild already uses.
  if (await isStaff(interaction as Interaction)) return null;

  return TOURNEY_MOD_DENIAL_MESSAGE;
}

/**
 * The refusal the staff check gives.
 *
 * Re-exported so the tourneys views have one place to read it from.
 */
export const STAFF_REFUSAL = STAFF_DENIAL_MESSAGE;
