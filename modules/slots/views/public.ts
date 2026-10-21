/**
 * The public panel's handlers: claim, cancel, remind and hand over a
 * slot.
 *
 * The panel itself — its body, its buttons and its refresh — lives in
 * `panel.ts`. This file is the behaviour behind the four buttons.
 *
 * The claim is the race the whole port exists to fix: the claim is one
 * conditional `UPDATE`, and the database settles it. There is no lock.
 */

import { EmbedBuilder, MessageFlags } from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  Client,
} from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { respond, replyError, replySuccess } from "../../../core/context.js";
import { awaitSelect } from "../../../core/select.js";
import { prompt } from "../../../core/prompt.js";
import { plural } from "../../../core/text.js";
import { PremiumFeature } from "../../../core/premium.js";
import { assertEntitled } from "../../premium/index.js";
import { buildPremiumGate, gateReason } from "../../premium/gate.js";
import { logger } from "../../../utils/logger.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotsId } from "../ids.js";
import type { SlotManagerRecord } from "../types.js";
import { buildModal } from "./components.js";
import {
  addScrimRole,
  channelName,
  removeScrimRole,
  resolveMembers,
} from "./helpers.js";
import {
  SLOT_MANAGER_DISABLED_MESSAGE,
  refreshGuildPanels,
  refreshPublicMessage,
} from "./panel.js";
import { clearPickMenu, issueModalToken, showPick } from "./pick.js";
import type { PickContext } from "./pick.js";
import { refreshScrimSlotlist } from "./slotlist.js";

/**
 * Handles one of the public panel's buttons.
 *
 * @param action the action from the custom id.
 * @param managerId the slot manager the panel belongs to.
 */
export async function handlePublicButton(
  interaction: ButtonInteraction,
  action: string,
  managerId: string | null,
): Promise<void> {
  if (!managerId) {
    await replyError(interaction, "That button is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const manager = await repo.getSlotManager(managerId);

  if (!manager) {
    await replyError(interaction, "This slot manager no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  if (action === "claim") {
    await handleClaim(interaction, manager);
    return;
  }

  if (action === "cancel") {
    await handleCancel(interaction, manager);
    return;
  }

  if (action === "remind") {
    await handleRemind(interaction, manager);
    return;
  }

  if (action === "idp") {
    await handleIdp(interaction, manager);
    return;
  }

  await replyError(interaction, "That button is no longer active.", {
    ephemeral: true,
  });
}

/**
 * The claim.
 *
 * The member picks a scrim, then writes the team name and the teammate
 * mentions in a form. **The mentions are the fix for B3**: the source
 * recorded only the claimer, so the ID-Pass transfer could never find a
 * teammate and the feature had never worked.
 */
async function handleClaim(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!manager.toggle) {
    await replyError(interaction, SLOT_MANAGER_DISABLED_MESSAGE);
    return;
  }

  const claimable = await service.listClaimableScrims(
    repo.slotStore,
    manager.id,
  );

  if (claimable.length === 0) {
    await replyError(interaction, "No slot available right now.");
    await refreshPublicMessage(interaction.client, manager.id);
    return;
  }

  const guild = interaction.guild;

  const options = claimable.map((entry) => ({
    label: `Slot ${entry.lowestFreeNum} ─ #${channelName(guild, entry.scrim.registrationChannelId)}`.slice(0, 100),
    value: `${entry.scrim.id}:${entry.lowestFreeNum}`,
    description: `${entry.scrim.name} — ${plural(entry.freeCount, "slot")} free`.slice(0, 100),
    emoji: "📇",
  }));

  const context: PickContext = { kind: "claim", managerId: manager.id };

  await showPick(interaction, options, context, {
    placeholder: "Select the slot you want to claim",
    question: "Select the slot you want to claim.",
    ephemeral: true,
  });
}

/**
 * The cancel.
 *
 * The whole flow is **public** (D43): the confirm prompt inside the
 * public slot message has to be visible to a second moderator.
 */
async function handleCancel(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  // A public defer, on purpose: the confirm prompt below is public.
  await interaction.deferReply();

  if (!manager.toggle) {
    await replyError(interaction, SLOT_MANAGER_DISABLED_MESSAGE);
    return;
  }

  const scrimIds = await repo.listSlotManagerScrimIds(manager.id);

  const slots = await repo.slotStore.listUserSlots(
    scrimIds,
    interaction.user.id,
  );

  if (slots.length === 0) {
    await replyError(interaction, "You have no slots that can be cancelled.");
    return;
  }

  const chosen = await awaitSelect(
    interaction,
    slots.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
      emoji: "📇",
    })),
    {
      maxValues: Math.min(slots.length, 25),
      placeholder: "Select slot(s) from this dropdown...",
      question: "Select the slots you want to remove.",
    },
  );

  if (chosen.length === 0) return;

  const confirmed = await prompt(
    interaction,
    `Your \`${plural(chosen.length, "slot")}\` will be cancelled.\n*Are you sure you want to continue?*`,
  );

  if (!confirmed) {
    await respond(interaction, { content: "Alright, Aborting." });
    return;
  }

  for (const slotId of chosen) {
    const result = await service.cancelSlot(repo.slotStore, {
      slotId,
      userId: interaction.user.id,
    });

    if (!result.ok) continue;

    if (result.roleRemoved) {
      await removeScrimRole(
        interaction.guild,
        result.slot.scrimId,
        interaction.user.id,
      );
    }

    await refreshPublicMessage(interaction.client, manager.id);
    await refreshScrimSlotlist(interaction.client, result.slot.scrimId);

    await dispatchReminders(
      interaction.client,
      result.slot.scrimId,
      manager.mainChannelId,
      manager.messageId,
    );
  }

  await replySuccess(
    interaction,
    `Cancelled your \`${plural(chosen.length, "slot")}\`.`,
  );
}

/**
 * The reminder.
 *
 * Premium-gated. The check happens **before** anything is written
 * (D15) — a refusal that came after the write could not be undone.
 */
async function handleRemind(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!manager.toggle) {
    await replyError(interaction, SLOT_MANAGER_DISABLED_MESSAGE);
    return;
  }

  const feature = PremiumFeature.slotReminders;

  try {
    await assertEntitled(manager.guildId, feature);
  } catch {
    const gate = buildPremiumGate(gateReason(feature));

    await respond(
      interaction,
      { embeds: [gate.embed], components: gate.components },
    );

    return;
  }

  const candidates = await service.collectReminderCandidates(repo.slotStore, {
    managerId: manager.id,
    userId: interaction.user.id,
    multipleSlots: manager.multipleSlots,
  });

  if (candidates.length === 0) {
    await replyError(
      interaction,
      "You can't set reminder in any scrim at this time.",
    );

    return;
  }

  const guild = interaction.guild;

  const chosen = await awaitSelect(
    interaction,
    candidates.slice(0, 25).map((candidate) => ({
      label: `#${channelName(guild, candidate.registrationChannelId)}`.slice(0, 100),
      value: candidate.scrimId,
      description: candidate.scrimName.slice(0, 100),
      emoji: "📇",
    })),
    {
      maxValues: Math.min(candidates.length, 25),
      placeholder: "Select scrims to add slot reminder",
      question:
        "Select 1 or multiple scrims to set reminder\n\n*By selecting scrims, you confirm that the bot can DM you when any slot is available of the selected scrims.*",
    },
  );

  if (chosen.length === 0) return;

  await service.createReminders(repo.slotStore, chosen, interaction.user.id);

  await replySuccess(
    interaction,
    `Successfully created reminder for ${plural(chosen.length, "scrim")}.`,
  );
}

/**
 * The ID-Pass transfer.
 *
 * Premium-gated. The slot's ownership and the scrim's role move to a
 * teammate **that was mentioned when the slot was claimed** — the fix
 * for B3.
 */
async function handleIdp(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!manager.toggle) {
    await replyError(interaction, SLOT_MANAGER_DISABLED_MESSAGE);
    return;
  }

  const feature = PremiumFeature.idpTransfer;

  try {
    await assertEntitled(manager.guildId, feature);
  } catch {
    const gate = buildPremiumGate(gateReason(feature));

    await respond(
      interaction,
      { embeds: [gate.embed], components: gate.components },
    );

    return;
  }

  const scrimIds = await repo.listSlotManagerScrimIds(manager.id);

  const slots = await repo.slotStore.listUserSlots(
    scrimIds,
    interaction.user.id,
  );

  if (slots.length === 0) {
    await replyError(
      interaction,
      "You don't have any slot that can be transferred.",
    );

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    slots.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
      emoji: "📇",
    })),
    {
      maxValues: 1,
      placeholder: "Select slot from this dropdown...",
      question: "Choose a slot to transfer ID-Pass Role to your teammates:",
    },
  );

  const slotId = chosen[0];

  if (!slotId) return;

  const candidates = await service.idpCandidates(repo.slotStore, {
    slotId,
    userId: interaction.user.id,
  });

  if (!candidates.ok) {
    if (candidates.reason === "no_teammate") {
      await replyError(
        interaction,
        "You cannot transfer the ID-Pass role to your teammates because you didn't mention them when you claimed the slot.",
      );

      return;
    }

    await replyError(interaction, "That slot no longer exists.");

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await replyError(interaction, "This only works in a server.");
    return;
  }

  // B10: resolving a member can come back empty. The source crashed on
  // the `None` inside a detached task.
  const members = await resolveMembers(guild, candidates.teammates);

  if (members.length === 0) {
    await replyError(
      interaction,
      "All your teammates seems to have left the server.",
    );

    return;
  }

  let newOwnerId: string | undefined;

  if (members.length === 1) {
    newOwnerId = members[0]?.id;
  } else {
    const picked = await awaitSelect(
      interaction,
      members.slice(0, 25).map((member) => ({
        label: member.displayName.slice(0, 100),
        value: member.id,
        emoji: "📇",
      })),
      {
        maxValues: 1,
        placeholder: "Select your teammate from this dropdown",
        question: "Please select your teammate to transfer ID-Pass Role.",
      },
    );

    newOwnerId = picked[0];
  }

  if (!newOwnerId) return;

  const result = await service.applyIdpTransfer(repo.slotStore, {
    slotId,
    newOwnerId,
    previousOwnerId: interaction.user.id,
  });

  if (!result.ok) {
    await replyError(interaction, "That slot no longer exists.");
    return;
  }

  await removeScrimRole(guild, result.slot.scrimId, interaction.user.id);
  await addScrimRole(guild, result.slot.scrimId, newOwnerId);

  await refreshPublicMessage(interaction.client, manager.id);
  await refreshScrimSlotlist(interaction.client, result.slot.scrimId);

  await replySuccess(
    interaction,
    `ID-Pass Role & Slot ownership transferred to <@${newOwnerId}>`,
  );
}

/* ------------------------------------------------------------------ *
 * The pick handlers
 * ------------------------------------------------------------------ */

/**
 * The claim's pick: the member chose the scrim and the slot number.
 *
 * The modal opens from this interaction, which is fresh — a select that
 * was consumed by a collector could not open one.
 */
export async function handleClaimPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "claim") return;

  const value = values[0];

  if (!value) return;

  const separator = value.lastIndexOf(":");

  if (separator <= 0) {
    await replyError(interaction, "That slot is no longer available.", {
      ephemeral: true,
    });

    return;
  }

  const scrimId = value.slice(0, separator);
  const num = Number(value.slice(separator + 1));

  if (!Number.isInteger(num)) {
    await replyError(interaction, "That slot is no longer available.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const token = issueModalToken({
    kind: "claim",
    managerId: context.managerId,
    scrimId,
    num,
  });

  await interaction.showModal(
    buildModal({
      customId: slotsId("modal_claim", token),
      title: "Claim a scrims slot",
      texts: [
        {
          id: "team_name",
          label: "Team Name",
          placeholder: "Enter your team name here...",
          required: true,
          minLength: 3,
          maxLength: 25,
        },
        {
          id: "members",
          label: "Teammates (mentions)",
          placeholder: "Mention your teammates, e.g. @Alice @Bob",
          required: false,
          maxLength: 200,
        },
      ],
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The reminder dispatch
 * ------------------------------------------------------------------ */

/**
 * Tells everybody who asked to be told that a slot is free.
 *
 * A reminder is **one-shot**: the rows are deleted after the dispatch,
 * so nobody is reminded about the same scrim twice.
 */
export async function dispatchReminders(
  client: Client,
  scrimId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const reminders = await repo.listReminders(scrimId);

  if (reminders.length === 0) return;

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  const guild = client.guilds.cache.get(scrim.guildId);

  if (!guild) return;

  const link = `https://discord.com/channels/${scrim.guildId}/${channelId}/${messageId}`;

  const embed = new EmbedBuilder()
    .setTitle(`Slot Available to Claim - ${guild.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      `A slot of ${scrim.name} is available to claim in <#${channelId}>!\nClaim it before anyone else do.`,
    )
    .setURL(link);

  for (const reminder of reminders) {
    const member = await guild.members.fetch(reminder.userId).catch(() => null);

    if (!member) continue;

    await member.send({ embeds: [embed] }).catch((error: unknown) => {
      logger.warn(`[Slots] Could not DM ${reminder.userId}:`, error);
    });
  }

  await repo.deleteReminders(scrimId);
}

/** Re-renders every panel of a guild. */
export async function refreshEveryPanel(
  client: Client,
  guildId: string,
): Promise<void> {
  await refreshGuildPanels(client, guildId);
}
