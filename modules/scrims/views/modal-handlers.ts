/**
 * The modal handlers.
 *
 * Every "type a value" flow is a modal (D17). The only exception in
 * this area is the match-time editor, which needs several
 * `#channel time` lines in one message and keeps a message collector.
 *
 * A modal writes **one** field and then re-renders the panel from the
 * row that comes back.
 */

import type { ModalSubmitInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import { parseNaturalTime } from "../../../core/time.js";
import { truncate } from "../../../core/text.js";
import { TEAM_NAME_MAX_LENGTH } from "../../../core/team-name.js";
import { PremiumFeature } from "../../../core/constants.js";
import type { Weekday } from "../../../db/schema/common.js";
import { assertEntitled } from "../../premium/index.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotNumbers } from "../slots.js";
import { modalText } from "./components.js";
import { writeBanLog } from "./ban-log.js";
import { takeSlotSelection } from "./slot-pick.js";
import {
  buildEditorPanel,
  buildWizardPanel,
  wizardStore,
} from "./manager.js";
import {
  buildAutocleanPanel,
  buildBanPanel,
  buildDesignPanel,
  buildReservePanel,
  buildSlotlistEditorPanel,
} from "./panels.js";
import {
  acknowledgeAndRender,
  fail,
  refuseUnlessMod,
  scrimPosition,
} from "./handlers.js";

/** Handles one modal submit. */
export async function handleScrimsModal(
  interaction: ModalSubmitInteraction,
  action: string,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  switch (action) {
    case "wizard":
      await handleWizardModal(interaction, parts);
      return;
    case "field":
      await handleFieldModal(interaction, parts);
      return;
    case "skip_to":
      await handleSkipToModal(interaction, parts);
      return;
    case "ban":
      await handleBanModal(interaction, parts);
      return;
    case "punish":
      await handlePunishModal(interaction, parts);
      return;
    case "slot_team":
      await handleSlotTeamModal(interaction, parts);
      return;
    case "reserve":
      await handleReserveModal(interaction, parts);
      return;
    case "autoclean_time":
      await handleAutocleanTimeModal(interaction, parts);
      return;
    case "design":
      await handleDesignModal(interaction, parts);
      return;
    default:
      await fail(interaction, "That form is no longer active.");
  }
}

/* ------------------------------------------------------------------ *
 * The wizard
 * ------------------------------------------------------------------ */

/** The wizard's modals. */
async function handleWizardModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [field, token] = parts;

  if (!field || !token) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const state = wizardStore.get(token);

  if (!state) {
    await fail(interaction, "This wizard has expired. Please run the command again.");

    return;
  }

  switch (field) {
    case "set_reg_channel":
    case "set_slot_channel":
    case "set_role": {
      // The wizard's channel and role fields are select menus, not
      // modal inputs (D17), so they are handled by the button handler
      // and never reach this one.
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_mentions": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 0 || value > 10) {
        await fail(interaction, "The number of mentions must be between 0 and 10.");

        return;
      }

      state.requiredMentions = value;

      break;
    }

    case "set_slots": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 1 || value > 30) {
        await fail(interaction, "The number of slots must be between 1 and 30.");

        return;
      }

      state.totalSlots = value;

      break;
    }

    case "set_open_time": {
      const parsed = parseNaturalTime(modalText(interaction));

      if (!parsed) {
        await fail(interaction, "I could not understand that time. Try `7 PM` or `tomorrow at 7 PM`.");

        return;
      }

      state.openTime = parsed;

      break;
    }

    case "set_emojis": {
      const emojis = modalText(interaction)
        .split(",")
        .map((emoji) => emoji.trim())
        .filter((emoji) => emoji.length > 0);

      if (emojis.length !== 2) {
        await fail(interaction, "Please enter two emojis, separated by a comma.");

        return;
      }

      const [tick, cross] = emojis;

      if (!tick || !cross) {
        await fail(interaction, "Please enter two emojis, separated by a comma.");

        return;
      }

      state.emojis = { tick, cross };

      break;
    }

    default:
      await fail(interaction, "That form is no longer active.");

      return;
  }

  const newToken = wizardStore.issue(state);
  wizardStore.delete(token);

  await acknowledgeAndRender(interaction, buildWizardPanel(state, newToken));
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

/** The editor's modals. */
async function handleFieldModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [key, scrimId] = parts;

  if (!key || !scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const field = EDITOR_FIELD_KEYS.find((entry) => entry === key);

  if (!field) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const patch: Record<string, unknown> = {};

  switch (key) {
    case "set_name": {
      const name = truncate(modalText(interaction), TEAM_NAME_MAX_LENGTH);

      if (name.length === 0) {
        await fail(interaction, "The name cannot be empty.");

        return;
      }

      patch.name = name;
      break;
    }

    case "set_reg_channel": {
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_slot_channel": {
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_role": {
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_ping_role": {
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_open_role": {
      await fail(interaction, "That form is no longer active.");

      return;
    }

    case "set_mentions": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 0 || value > 10) {
        await fail(interaction, "The number of mentions must be between 0 and 10.");

        return;
      }

      patch.requiredMentions = value;
      break;
    }

    case "set_slots": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 1 || value > 30) {
        await fail(interaction, "The number of slots must be between 1 and 30.");

        return;
      }

      patch.totalSlots = value;
      break;
    }

    case "set_start_from": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 1) {
        await fail(interaction, "The first slot number must be 1 or more.");

        return;
      }

      patch.startFrom = value;
      break;
    }

    case "set_lines": {
      const value = Number(modalText(interaction));

      if (!Number.isInteger(value) || value < 0 || value > 100) {
        await fail(interaction, "The number of lines must be between 0 and 100.");

        return;
      }

      try {
        await assertEntitled(scrim.guildId, PremiumFeature.scrimSlots);
      } catch (error) {
        await fail(
          interaction,
          error instanceof Error ? error.message : "This feature is premium.",
        );

        return;
      }

      patch.requiredLines = value;
      break;
    }

    case "set_open_time": {
      const parsed = parseNaturalTime(modalText(interaction));

      if (!parsed) {
        await fail(interaction, "I could not understand that time. Try `7 PM` or `tomorrow at 7 PM`.");

        return;
      }

      patch.openTime = parsed;
      break;
    }

    case "set_emojis": {
      const emojis = modalText(interaction)
        .split(",")
        .map((emoji) => emoji.trim())
        .filter((emoji) => emoji.length > 0);

      const [tick, cross] = emojis;

      if (emojis.length !== 2 || !tick || !cross) {
        await fail(interaction, "Please enter two emojis, separated by a comma.");

        return;
      }

      try {
        await assertEntitled(scrim.guildId, PremiumFeature.scrimSlots);
      } catch (error) {
        await fail(
          interaction,
          error instanceof Error ? error.message : "This feature is premium.",
        );

        return;
      }

      patch.emojis = { tick, cross };
      break;
    }

    default:
      await fail(interaction, "That form is no longer active.");

      return;
  }

  await repo.updateScrim(
    scrim.id,
    patch as Parameters<typeof repo.updateScrim>[1],
  );

  const fresh = await repo.getScrim(scrim.id);

  if (!fresh) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  await acknowledgeAndRender(
    interaction,
    buildEditorPanel(fresh, await scrimPosition(fresh), true),
  );
}

/** The editor's field keys, as the modal custom id spells them. */
const EDITOR_FIELD_KEYS = [
  "set_name",
  "set_reg_channel",
  "set_slot_channel",
  "set_role",
  "set_mentions",
  "set_slots",
  "set_open_time",
  "set_emojis",
  "set_ping_role",
  "set_open_role",
  "set_start_from",
  "set_lines",
] as const;

/* ------------------------------------------------------------------ *
 * "Skip to"
 * ------------------------------------------------------------------ */

/**
 * The editor's "Skip to" form.
 *
 * The source's button only deferred and did nothing. This one takes the
 * number of the scrim in the list and moves the editor there.
 */
async function handleSkipToModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const all = await repo.listScrims(scrim.guildId);

  const raw = modalText(interaction);
  const number = Number(raw);

  let target: typeof scrim | undefined;

  if (/^\d+$/.test(raw)) {
    target = all[number - 1];
  } else {
    target = all.find((entry) => entry.id === raw);
  }

  if (!target) {
    await fail(interaction, `There is no scrim ${raw} in this server.`);

    return;
  }

  await acknowledgeAndRender(
    interaction,
    buildEditorPanel(target, await scrimPosition(target), true),
  );
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** The ban form: who, for how long, and why. */
async function handleBanModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const userIds = mentionIds(modalText(interaction, "users"));

  if (userIds.length === 0) {
    await fail(interaction, "You didn't mention any user to ban.");

    return;
  }

  const duration = modalText(interaction, "duration");
  const reason = modalText(interaction, "reason");

  const expires = duration ? parseNaturalTime(`in ${duration}`) : null;

  const guild = interaction.guild;

  for (const userId of userIds) {
    await service.banUsers({
      scrimId: scrim.id,
      mode: 1,
      leaderId: userId,
      memberIds: [userId],
      teamName: null,
      reason: reason.length > 0 ? reason : null,
      expires,
    });

    if (guild) {
      await writeBanLog(guild, {
        action: "banned",
        userId,
        scrimName: scrim.name,
        reason: reason.length > 0 ? reason : null,
        expires,
        moderatorId: interaction.user.id,
      });
    }
  }

  const bans = await repo.listBans(scrim.id);

  await acknowledgeAndRender(interaction, buildBanPanel(scrim, bans));
}

/** The punish form: for how long, and why. */
async function handlePunishModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const duration = modalText(interaction, "duration");
  const reason = modalText(interaction, "reason");

  const expires = duration ? parseNaturalTime(`in ${duration}`) : null;

  const slotIds = punishSelection.get(scrimId) ?? [];
  punishSelection.delete(scrimId);

  const guild = interaction.guild;

  for (const slotId of slotIds) {
    const slot = await repo.getSlot(slotId);

    if (!slot) continue;

    await service.banUsers({
      scrimId: scrim.id,
      mode: 1,
      leaderId: slot.ownerUserId ?? "",
      memberIds: slot.members,
      teamName: slot.teamName,
      reason: reason.length > 0 ? reason : null,
      expires,
    });

    if (guild && slot.ownerUserId) {
      await writeBanLog(guild, {
        action: "banned",
        userId: slot.ownerUserId,
        scrimName: scrim.name,
        reason: reason.length > 0 ? reason : null,
        expires,
        moderatorId: interaction.user.id,
      });
    }
  }

  const bans = await repo.listBans(scrim.id);

  await acknowledgeAndRender(interaction, buildBanPanel(scrim, bans));
}

/**
 * The slots a punish is waiting on.
 *
 * A multi-select's values cannot travel in a custom id — twenty-five
 * uuids do not fit in a hundred characters — so the selection is kept
 * in a token store, keyed by the scrim (D18).
 */
export const punishSelection = new Map<string, string[]>();

/* ------------------------------------------------------------------ *
 * The slotlist editor
 * ------------------------------------------------------------------ */

/**
 * Adds or changes the team on a slot.
 *
 * The source wrote the team name and the owner in two separate
 * statements, which could leave a half-changed slot behind. Ours is one
 * statement.
 *
 * The state the pick collected — the scrim, the slot and the member who
 * opened the menu — travels in a token (D18). See `views/slot-pick.ts`.
 */
async function handleSlotTeamModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [token] = parts;

  if (!token) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const selection = takeSlotSelection(token);

  if (!selection) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  // The form belongs to the member who opened the menu. Discord only
  // shows a modal to the member who triggered it, so this is a second
  // lock rather than the first one.
  if (selection.userId !== interaction.user.id) {
    await fail(interaction, "That form is not yours.");

    return;
  }

  const scrim = await repo.getScrim(selection.scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const teamName = truncate(modalText(interaction, "team_name"), 25);

  if (teamName.length === 0) {
    await fail(interaction, "The team name cannot be empty.");

    return;
  }

  const leaderIds = mentionIds(modalText(interaction, "leader"));
  const leaderId = leaderIds[0] ?? null;

  const slot = await repo.getSlot(selection.slotId);

  if (!slot) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  if (slot.state === "free") {
    // The slot is free: claim it for the team.
    const claimed = await repo.claimSlot(scrim.id, slot.num, {
      teamName,
      ownerUserId: leaderId ?? "",
      members: leaderIds.length > 0 ? leaderIds : [],
      messageId: null,
      jumpUrl: null,
    });

    if (!claimed) {
      await fail(interaction, "Somebody else took that slot first.");

      return;
    }
  } else {
    await repo.changeSlotTeam(slot.id, {
      teamName,
      ownerUserId: leaderId,
      members: leaderIds.length > 0 ? leaderIds : [],
    });
  }

  const fresh = await repo.getScrim(scrim.id);

  if (!fresh) return;

  await acknowledgeAndRender(
    interaction,
    buildSlotlistEditorPanel(fresh),
  );
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** The reserved-slot form. */
async function handleReserveModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const num = Number(modalText(interaction, "num"));
  const teamName = truncate(modalText(interaction, "team_name"), 25);
  const ownerIds = mentionIds(modalText(interaction, "owner"));
  const expiresRaw = modalText(interaction, "expires");

  if (!Number.isInteger(num)) {
    await fail(interaction, "The slot number must be a number.");

    return;
  }

  if (teamName.length === 0) {
    await fail(interaction, "The team name cannot be empty.");

    return;
  }

  const expires = expiresRaw ? parseNaturalTime(expiresRaw) : null;

  try {
    await service.reserveSlot({
      scrimId: scrim.id,
      num,
      teamName,
      ownerUserId: ownerIds[0] ?? null,
      members: ownerIds,
      expires,
    });
  } catch (error) {
    await fail(
      interaction,
      error instanceof Error ? error.message : "The slot could not be reserved.",
    );

    return;
  }

  const reserved = await repo.listReservedSlots(scrim.id);

  await acknowledgeAndRender(interaction, buildReservePanel(scrim, reserved));
}

/* ------------------------------------------------------------------ *
 * Autoclean
 * ------------------------------------------------------------------ */

/** The autoclean time form. */
async function handleAutocleanTimeModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const parsed = parseNaturalTime(modalText(interaction));

  if (!parsed) {
    await fail(interaction, "I could not understand that time. Try `4 AM` or `tomorrow at 4 AM`.");

    return;
  }

  await repo.updateScrim(scrim.id, { autocleanTime: parsed });
  await service.armDailyJobs({ ...scrim, autocleanTime: parsed });

  const fresh = await repo.getScrim(scrim.id);

  if (!fresh) return;

  await acknowledgeAndRender(interaction, buildAutocleanPanel(fresh));
}

/* ------------------------------------------------------------------ *
 * The design
 * ------------------------------------------------------------------ */

/** The message-design form. */
async function handleDesignModal(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const [kind, scrimId] = parts;

  if (!kind || !scrimId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const title = modalText(interaction, "title");
  const description = modalText(interaction, "description");
  const footer = modalText(interaction, "footer");

  const template = {
    ...(title.length > 0 ? { title } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(footer.length > 0 ? { footer: { text: footer } } : {}),
  };

  if (Object.keys(template).length === 0) {
    await fail(interaction, "Fill in at least one of the fields, or press Cancel.");

    return;
  }

  if (kind === "open") {
    await repo.updateScrim(scrim.id, { openMessage: template });
  } else if (kind === "close") {
    await repo.updateScrim(scrim.id, { closeMessage: template });
  } else {
    await repo.updateScrim(scrim.id, { slotlistFormat: template });
  }

  const fresh = await repo.getScrim(scrim.id);

  if (!fresh) return;

  await acknowledgeAndRender(interaction, buildDesignPanel(fresh));
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The user ids in a piece of text.
 *
 * The ban form takes the mentions as text — Discord has no "pick a
 * user" select, and a message collector for one value is exactly what
 * D17 forbids.
 */
export function mentionIds(text: string): string[] {
  const ids = new Set<string>();

  for (const match of text.matchAll(/<@!?(\d+)>/g)) {
    const id = match[1];

    if (id) ids.add(id);
  }

  return [...ids];
}

/** The follow-up flags. */
export const EPHEMERAL = MessageFlags.Ephemeral;

/** The weekday type, re-exported for the callers that build the array. */
export type { Weekday };

/** The slot numbers of a scrim, for the callers that validate them. */
export { slotNumbers };
