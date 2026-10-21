/**
 * The module's interactions.
 *
 * The router lives in `core/router.ts`. This module registers the custom
 * ids it owns and nothing else: the router dispatches on the prefix, so
 * an id's owner is never guessed from its shape.
 *
 * The manager wires this in once, from the place the router is built:
 *
 * ```ts
 * registerModerationInteractions();
 * ```
 */

import type { ButtonInteraction } from "discord.js";
import { parseCustomId } from "../../../core/custom-id.js";
import { registerButton } from "../../../core/router.js";
import {
  handleRoleRevertButton,
  MODERATION_CUSTOM_ID_PREFIX,
} from "./role-revert.js";

/**
 * Registers this module's interactions with the router.
 *
 * The prefix is `moderation`, and the action is `role_revert`, so the
 * custom id of the revert button is `moderation:role_revert:<action>:<token>`.
 */
export function registerModerationInteractions(): void {
  registerButton(
    `${MODERATION_CUSTOM_ID_PREFIX}:role_revert`,
    async (interaction, payload) => {
      await handleRoleRevertButton(interaction, payload);
    },
  );
}

/**
 * Handles an interaction that belongs to this module.
 *
 * The router is the normal path. This is for a dispatcher that has no
 * router yet: it answers "did the moderation module handle this?".
 *
 * @returns whether the interaction was handled.
 */
export async function handleModerationInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);

  if (!parsed || parsed.type !== MODERATION_CUSTOM_ID_PREFIX) return false;

  if (parsed.action === "role_revert") {
    return handleRoleRevertButton(interaction, parsed.payload);
  }

  return false;
}
