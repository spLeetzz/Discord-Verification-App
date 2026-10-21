/**
 * The forms behind the slot flows.
 *
 * Three of them, and every one of them is a **modal** (D17). The source
 * asked for a team name and a ban reason with chat-message collectors
 * and a keycap button row; those are exactly the flows D17 replaces.
 *
 * A modal's custom id carries a token, and the token points at the state
 * the earlier steps of the flow collected (D18). The token is the
 * ephemeral half: it is only meaningful to the process that issued it,
 * and it expires.
 */

import type { ModalSubmitInteraction } from "discord.js";
import { replyError, replySuccess } from "../../../core/context.js";
import { parseDuration, parseNaturalTime } from "../../../core/time.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { firstMentionId } from "../mentions.js";
import { addScrimRole, removeScrimRole } from "./helpers.js";
import { refreshPublicMessage } from "./panel.js";
import { takeModalToken } from "./pick.js";
import { afterSlotChange, punishSlots } from "./slotlist.js";

/**
 * The refusals the claim can give.
 *
 * The source's wording, because it is the wording the users of the old
 * bot already know.
 */
const CLAIM_REFUSALS: Record<string, string> = {
  no_slot: "No slot available right now.",
  scrim_gone: "Scrim not found.",
  banned: "You are banned from this scrim.",
  already_holds: "You already have a slot in this scrim.",
  taken: "Somebody claimed this slot before you.",
  invalid_team_name: "Team name cannot be empty.",
};

/** A text input's value, or an empty string. */
export function modalText(
  interaction: ModalSubmitInteraction,
  id: string,
): string {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return "";
  }
}

/**
 * Handles a form.
 *
 * @param action the action from the custom id.
 * @param token  the token the form carries.
 */
export async function handleSlotModal(
  interaction: ModalSubmitInteraction,
  action: string,
  token: string | null,
): Promise<void> {
  if (!token) {
    await replyError(interaction, "That form is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const context = takeModalToken(token);

  if (!context) {
    await replyError(interaction, "That form is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  if (action === "modal_claim") {
    await handleClaimModal(interaction, context);
    return;
  }

  if (action === "modal_punish") {
    await handlePunishModal(interaction, context);
    return;
  }

  if (action === "modal_team") {
    await handleTeamModal(interaction, context);
    return;
  }

  await replyError(interaction, "That form is no longer active.", {
    ephemeral: true,
  });
}

/**
 * The claim form.
 *
 * The team name and the **teammate mentions**. The mentions are the
 * fix for B3 — without them the ID-Pass transfer has nobody to transfer
 * to, and the feature has never worked.
 */
async function handleClaimModal(
  interaction: ModalSubmitInteraction,
  context: Awaited<ReturnType<typeof takeModalToken>> & object,
): Promise<void> {
  if (context.kind !== "claim") {
    await replyError(interaction, "That form is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const teamName = modalText(interaction, "team_name");
  const mentions = modalText(interaction, "members");

  const manager = await repo.getSlotManager(context.managerId);

  if (!manager) {
    await replyError(interaction, "This slot manager no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  const result = await service.claimSlot(repo.slotStore, {
    scrimId: context.scrimId,
    num: context.num,
    userId: interaction.user.id,
    teamNameInput: teamName,
    mentionText: mentions,
    multipleSlots: manager.multipleSlots,
  });

  if (!result.ok) {
    await replyError(
      interaction,
      CLAIM_REFUSALS[result.reason] ?? "That slot could not be claimed.",
      { ephemeral: true },
    );

    return;
  }

  await addScrimRole(interaction.guild, context.scrimId, interaction.user.id);

  await refreshPublicMessage(interaction.client, manager.id);
  await afterSlotChange(interaction.client, context.scrimId);

  await replySuccess(interaction, "Slot claimed successfully.", {
    ephemeral: true,
  });
}

/**
 * The punish form: the ban duration and the reason.
 */
async function handlePunishModal(
  interaction: ModalSubmitInteraction,
  context: Awaited<ReturnType<typeof takeModalToken>> & object,
): Promise<void> {
  if (context.kind !== "punish") {
    await replyError(interaction, "That form is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const duration = modalText(interaction, "duration");
  const reason = modalText(interaction, "reason");

  const expires = duration ? parseBanExpiry(duration) : null;

  const outcome = await punishSlots({
    scrimId: context.scrimId,
    slotIds: context.slotIds,
    mode: context.mode,
    reason: reason.length > 0 ? reason : null,
    expires,
    moderatorId: interaction.user.id,
    guild: interaction.guild,
  });

  await afterSlotChange(interaction.client, context.scrimId);

  await replySuccess(interaction, outcome, { ephemeral: true });
}

/**
 * The team form: the team name and the leader.
 *
 * One form, two jobs: adding a team and changing one. The token says
 * which.
 */
async function handleTeamModal(
  interaction: ModalSubmitInteraction,
  context: Awaited<ReturnType<typeof takeModalToken>> & object,
): Promise<void> {
  if (context.kind !== "add_team" && context.kind !== "change_team") {
    await replyError(interaction, "That form is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const teamName = modalText(interaction, "team_name");
  const leaderText = modalText(interaction, "leader");
  const leaderId = firstMentionId(leaderText);

  if (context.kind === "add_team") {
    const result = await service.addTeam(repo.slotStore, {
      scrimId: context.scrimId,
      num: context.num,
      teamNameInput: teamName,
      leaderId,
    });

    if (!result.ok) {
      await replyError(
        interaction,
        result.reason === "taken"
          ? "That slot is no longer free."
          : "Team name cannot be empty.",
        { ephemeral: true },
      );

      return;
    }

    if (leaderId) {
      await addScrimRole(interaction.guild, context.scrimId, leaderId);
    }

    await afterSlotChange(interaction.client, context.scrimId);

    await replySuccess(interaction, "Team added successfully.", {
      ephemeral: true,
    });

    return;
  }

  const result = await service.changeTeam(repo.slotStore, {
    slotId: context.slotId,
    teamNameInput: teamName,
    leaderId,
  });

  if (!result.ok) {
    await replyError(
      interaction,
      result.reason === "not_found"
        ? "That slot no longer exists."
        : "Team name cannot be empty.",
      { ephemeral: true },
    );

    return;
  }

  if (result.roleRemoved && result.previousOwnerId) {
    await removeScrimRole(
      interaction.guild,
      result.slot.scrimId,
      result.previousOwnerId,
    );
  }

  if (leaderId) {
    await addScrimRole(interaction.guild, result.slot.scrimId, leaderId);
  }

  await afterSlotChange(interaction.client, result.slot.scrimId);

  await replySuccess(interaction, "Slotlist updated successfully.", {
    ephemeral: true,
  });
}

/**
 * Reads a ban duration.
 *
 * "7 days", "24h", "in 2 hours" — a fixed length first, then a natural
 * time. The source's `TimeText` converter did the same thing.
 *
 * @returns the instant the ban ends, or `null` when the text holds no
 *          time at all.
 */
export function parseBanExpiry(text: string): Date | null {
  const trimmed = text.trim();

  if (!trimmed) return null;

  const duration = parseDuration(trimmed);

  if (duration !== null && duration > 0) {
    return new Date(Date.now() + duration);
  }

  return parseNaturalTime(`in ${trimmed}`);
}
