/**
 * The button handlers of the tournaments area.
 *
 * Every handler does **one** thing and re-renders the panel from the row
 * that comes back. Nothing is held in memory between clicks, so a panel
 * that is opened after a restart shows the truth (D18).
 *
 * The handlers that need a value open a **modal** or a **select menu** —
 * never a chat-message collector (D17).
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { ButtonInteraction, Guild } from "discord.js";
import { StringSelectMenuBuilder } from "discord.js";
import { prompt } from "../../../core/prompt.js";
import { awaitSelect } from "../../../core/select.js";
import { respond } from "../../../core/context.js";
import { PremiumFeature } from "../../../core/constants.js";
import { run } from "../../../core/fire-and-forget.js";
import { panelEmbed, componentRow } from "../../../core/ui.js";
import { logger } from "../../../utils/logger.js";
import { assertEntitled } from "../../premium/entitlements.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import type { TourneyRecord } from "../types.js";
import { EDITOR_FIELDS } from "./components.js";
import { buildEditorPanel } from "./editor.js";
import { buildGroupManagerPanel, buildPublishedGroupList } from "./groups.js";
import { handleIdpCopy } from "./idp.js";
import { acknowledge, fail, refuseUnlessMod, renderPanel } from "./handlers.js";
import {
  closeTourneyInGuild,
  openTourneyInGuild,
  pauseTourneyInGuild,
  removeSuccessRole,
  strikeConfirmMessage,
} from "./lifecycle.js";
import { buildManagerPanel, buildTourneyPanel } from "./manager.js";
import {
  buildFieldModal,
  buildTwoInputModal,
  copyFor,
  FIELD_MODAL_COPY,
  MODAL_COPY,
  TWO_INPUT_COPY,
} from "./modals.js";
import { buildPartnerPanel } from "./partner.js";
import { awaitChannelSelect, awaitRoleSelect } from "../../../core/select.js";
import { buildSlotManagerPanel } from "./slotm.js";
import { tourneysId } from "./ids.js";
import { buildWizardPanel, parseOpenDays, wizardStore } from "./wizard.js";

/** The cooldown of the group list's Refresh button. */
export const GROUP_REFRESH_COOLDOWN_MS = 120_000;

/**
 * Handles one button press.
 */
export async function handleTourneysButton(
  interaction: ButtonInteraction,
  action: string,
  parts: readonly string[],
): Promise<void> {
  switch (action) {
    case "manager":
      await onManager(interaction, parts);
      return;
    case "wizard":
      await onWizard(interaction, parts);
      return;
    case "editor":
      await onEditor(interaction, parts);
      return;
    case "lifecycle":
      await onLifecycle(interaction, parts);
      return;
    case "ban":
      await onBan(interaction, parts);
      return;
    case "groups":
      await onGroups(interaction, parts);
      return;
    case "group_publish":
      await onGroupPublish(interaction, parts);
      return;
    case "group_refresh":
      await onGroupRefresh(interaction, parts);
      return;
    case "slotm":
      await onSlotManager(interaction, parts);
      return;
    case "slotm_cancel":
      await onSlotCancel(interaction, parts);
      return;
    case "slotm_rename":
      await onSlotRename(interaction, parts);
      return;
    case "slotm_swap":
      await onSlotSwap(interaction, parts);
      return;
    case "partner":
      await onPartner(interaction, parts);
      return;
    case "partner_add":
      await onPartnerAdd(interaction, parts);
      return;
    case "partner_remove":
      await onPartnerRemove(interaction, parts);
      return;
    case "idp_copy":
      await handleIdpCopy(interaction);
      return;
    case "modal":
      await onModalButton(interaction, parts);
      return;
    default:
      await fail(interaction, "That button is no longer active.");
  }
}

/**
 * The buttons that open a modal.
 *
 * The kind is the first part of the custom id; the rest identifies the
 * record the modal writes to.
 */
async function onModalButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const kind = parts[0];
  const tourneyId = parts[1];

  if (!kind || !tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  if (kind === "add_slot") {
    const copy = TWO_INPUT_COPY.add_slot;

    await interaction.showModal(
      buildTwoInputModal({
        customId: tourneysId("modal", "add_slot", tourney.id),
        title: copy.title,
        first: {
          id: "leader",
          label: copy.first.label,
          placeholder: copy.first.placeholder,
        },
        second: {
          id: "name",
          label: copy.second.label,
          placeholder: copy.second.placeholder,
        },
      }),
    );

    return;
  }

  if (kind === "remove_slot") {
    const copy = TWO_INPUT_COPY.remove_slot;

    await interaction.showModal(
      buildTwoInputModal({
        customId: tourneysId("modal", "remove_slot", tourney.id),
        title: copy.title,
        first: {
          id: "member",
          label: copy.first.label,
          placeholder: copy.first.placeholder,
        },
        second: {
          id: "num",
          label: copy.second.label,
          placeholder: copy.second.placeholder,
        },
      }),
    );

    return;
  }

  if (kind === "export") {
    const copy = MODAL_COPY.export;

    await interaction.showModal(
      buildFieldModal({
        customId: tourneysId("modal", "export", tourney.id),
        title: copy.title,
        label: copy.label,
        placeholder: copy.placeholder,
        required: copy.required,
      }),
    );

    return;
  }

  if (kind === "group_format") {
    const copy = TWO_INPUT_COPY.group_format;

    await interaction.showModal(
      buildTwoInputModal({
        customId: tourneysId("modal", "group_format", tourney.id),
        title: copy.title,
        first: {
          id: "format",
          label: copy.first.label,
          placeholder: copy.first.placeholder,
        },
        second: {
          id: "range",
          label: copy.second.label,
          placeholder: copy.second.placeholder,
        },
      }),
    );

    return;
  }

  if (kind === "set_start_from") {
    const copy = MODAL_COPY.set_start_from;

    await interaction.showModal(
      buildFieldModal({
        customId: tourneysId("modal", "set_start_from", tourney.id),
        title: copy.title,
        label: copy.label,
        placeholder: copy.placeholder,
        required: copy.required,
        maxLength: copy.maxLength,
      }),
    );

    return;
  }

  await fail(interaction, "That button is no longer active.");
}

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

/** The manager panel, or the panel of one tournament. */
async function onManager(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const guildId = interaction.guildId;

  if (!guildId) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const tourneyId = parts[0];

  if (tourneyId && tourneyId !== "refresh") {
    const tourney = await repo.getTourney(tourneyId);

    if (!tourney) {
      await fail(interaction, "This tournament no longer exists.");

      return;
    }

    await acknowledge(interaction);
    await renderPanel(interaction, buildTourneyPanel(tourney));

    return;
  }

  const tourneys = await repo.listTourneys(guildId);

  await acknowledge(interaction);
  await renderPanel(interaction, buildManagerPanel(tourneys));
}

/* ------------------------------------------------------------------ *
 * The wizard
 * ------------------------------------------------------------------ */

async function onWizard(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const key = parts[0];

  if (!key) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  if (key === "new") {
    const guildId = interaction.guildId;

    if (!guildId) {
      await fail(interaction, "This only works in a server.");

      return;
    }

    const draft = service.newDraft(guildId, interaction.user.id);
    const token = wizardStore.issue(draft);

    await acknowledge(interaction);
    await renderPanel(interaction, buildWizardPanel(draft, token));

    return;
  }

  const token = parts[1];

  if (!token) {
    await fail(interaction, "That button is no longer active.");

    return;
  }
  const draft = wizardStore.get(token);

  if (!draft) {
    await fail(
      interaction,
      "This setup wizard has expired. Run the command again to start a new one.",
    );

    return;
  }

  if (key === "cancel") {
    wizardStore.delete(token);

    const tourneys = await repo.listTourneys(draft.guildId);

    await acknowledge(interaction);
    await renderPanel(interaction, buildManagerPanel(tourneys));

    return;
  }

  if (key === "save") {
    await saveWizard(interaction, token, draft);

    return;
  }

  const field = wizardField(key);

  if (!field) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  if (field.kind === "channel") {
    const [channelId] = await awaitChannelSelect(interaction, {
      placeholder: `Pick the ${field.label.toLowerCase()}`,
    });

    if (!channelId) return;

    const updated = { ...draft, [key]: channelId } as typeof draft;

    wizardStore.set(token, updated);

    await acknowledge(interaction);
    await renderPanel(interaction, buildWizardPanel(updated, token));

    return;
  }

  if (field.kind === "role") {
    const [roleId] = await awaitRoleSelect(interaction, {
      placeholder: "Pick the success role",
    });

    if (!roleId) return;

    const updated = { ...draft, [key]: roleId } as typeof draft;

    wizardStore.set(token, updated);

    await acknowledge(interaction);
    await renderPanel(interaction, buildWizardPanel(updated, token));

    return;
  }

  const copy = copyFor(FIELD_MODAL_COPY, key);

  if (!copy) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "wizard_field", token, key),
      title: copy.title,
      label: copy.label,
      placeholder: copy.placeholder,
      required: copy.required,
      maxLength: copy.maxLength,
      style: copy.style,
      value: wizardValue(draft, key),
    }),
  );
}

/** The wizard's field table, as a lookup. */
function wizardField(
  key: string,
): { kind: string; label: string } | null {
  const fields: Record<string, { kind: string; label: string }> = {
    set_reg_channel: { kind: "channel", label: "Registration Channel" },
    set_confirm_channel: { kind: "channel", label: "Confirm Channel" },
    set_role: { kind: "role", label: "Success Role" },
    set_mentions: { kind: "number", label: "Mentions" },
    set_slots: { kind: "number", label: "Total Slots" },
    set_group_size: { kind: "number", label: "Teams per Group" },
    set_emojis: { kind: "emojis", label: "Reactions" },
    set_open_days: { kind: "days", label: "Open Days" },
    set_open_time: { kind: "text", label: "Open Time" },
  };

  return fields[key] ?? null;
}

/** The current value of a wizard field, as the modal shows it. */
function wizardValue(
  draft: Parameters<typeof service.createTourneyFromWizard>[0] & {
    openDays: string[];
    openTime: string;
  },
  key: string,
): string {
  switch (key) {
    case "set_mentions":
      return String(draft.requiredMentions);
    case "set_slots":
      return String(draft.totalSlots ?? "");
    case "set_group_size":
      return String(draft.groupSize ?? "");
    case "set_emojis":
      return `${draft.emojis.tick},${draft.emojis.cross}`;
    case "set_open_days":
      return draft.openDays.join(", ");
    case "set_open_time":
      return draft.openTime;
    default:
      return "";
  }
}

/** Creates the tournament a finished wizard describes. */
async function saveWizard(
  interaction: ButtonInteraction,
  token: string,
  draft: Parameters<typeof service.createTourneyFromWizard>[0] & {
    openDays: string[];
    openTime: string;
  },
): Promise<void> {
  try {
    const id = await service.createTourneyFromWizard(draft);

    wizardStore.delete(token);

    const tourney = await repo.getTourney(id);

    if (!tourney) {
      await fail(interaction, "The tournament could not be created.");

      return;
    }

    await service.armOpenJob(id, {
      openDays: draft.openDays,
      openTime: draft.openTime,
    });

    await acknowledge(interaction);
    await renderPanel(interaction, buildTourneyPanel(tourney));
  } catch (error) {
    await fail(
      interaction,
      error instanceof Error
        ? error.message
        : "The tournament could not be created.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

async function onEditor(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const key = parts[0];
  const tourneyId = parts[1];

  // The hub's "Edit settings" button carries only the tournament id —
  // it opens the editor rather than setting a field. So a one-part id
  // is the editor, and a two-part id is a field of it. It used to fall
  // through to the field branch, which read the tournament id as a
  // field name and refused the press: the panel's primary button was
  // dead.
  if (key && !tourneyId) {
    const tourney = await repo.getTourney(key);

    if (!tourney) {
      await fail(interaction, "This tournament no longer exists.");

      return;
    }

    await acknowledge(interaction);
    await renderPanel(interaction, await buildEditor(tourney));

    return;
  }

  if (!key || !tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  if (key === "delete") {
    const confirmed = await prompt(
      interaction,
      "Are you sure you want to delete this tournament?\n\n`This action is not reversible.`",
    );

    if (!confirmed) {
      await acknowledge(interaction);
      await renderPanel(interaction, await buildEditor(tourney));

      return;
    }

    await service.closeTourney(tourney.id).catch(() => undefined);
    await repo.deleteTourney(tourney.id);

    const tourneys = await repo.listTourneys(tourney.guildId);

    await acknowledge(interaction);
    await renderPanel(interaction, buildManagerPanel(tourneys));

    return;
  }

  const field = EDITOR_FIELDS.find((entry) => entry.key === key);

  if (!field) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  if (field.premium) {
    const refusal = await premiumRefusal(tourney, field.key);

    if (refusal) {
      await fail(interaction, refusal);

      return;
    }
  }

  if (field.kind === "toggle") {
    await toggleField(interaction, tourney, field.column ?? field.key);

    return;
  }

  if (field.kind === "channel") {
    const [channelId] = await awaitChannelSelect(interaction, {
      placeholder: `Pick the ${field.label.toLowerCase()}`,
    });

    if (!channelId) return;

    if (
      key === "set_reg_channel" &&
      (await repo.isRegistrationChannelTaken(channelId, tourney.id))
    ) {
      await fail(
        interaction,
        "Another tournament is already running in that registration channel.",
      );

      return;
    }

    const column =
      key === "set_reg_channel"
        ? "registrationChannelId"
        : "confirmChannelId";

    await repo.updateTourney(tourney.id, { [column]: channelId });

    await acknowledge(interaction);
    await renderPanel(interaction, await buildEditor(tourney));

    return;
  }

  if (field.kind === "role") {
    const [roleId] = await awaitRoleSelect(interaction, {
      placeholder: `Pick the ${field.label.toLowerCase()}`,
    });

    if (!roleId) return;

    const column =
      key === "set_role"
        ? "roleId"
        : key === "set_ping_role"
          ? "pingRoleId"
          : "openRoleId";

    await repo.updateTourney(tourney.id, { [column]: roleId });

    await acknowledge(interaction);
    await renderPanel(interaction, await buildEditor(tourney));

    return;
  }

  const copy = copyFor(FIELD_MODAL_COPY, key);

  if (!copy) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "editor_field", tourney.id, key),
      title: copy.title,
      label: copy.label,
      placeholder: copy.placeholder,
      required: copy.required,
      maxLength: copy.maxLength,
      style: copy.style,
      value: currentFieldValue(tourney, key),
    }),
  );
}

/** The editor panel of a tournament, with its schedule. */
async function buildEditor(tourney: TourneyRecord) {
  const schedule = await service.getSchedule(tourney.id);

  return buildEditorPanel(tourney, schedule);
}

/** The current value of an editor field, as the modal shows it. */
function currentFieldValue(tourney: TourneyRecord, key: string): string {
  switch (key) {
    case "set_name":
      return tourney.name;
    case "set_mentions":
      return String(tourney.requiredMentions);
    case "set_slots":
      return String(tourney.totalSlots);
    case "set_group_size":
      return tourney.groupSize ? String(tourney.groupSize) : "";
    case "set_emojis":
      return `${tourney.emojis.tick},${tourney.emojis.cross}`;
    case "set_lines":
      return String(tourney.requiredLines);
    case "set_start_from":
      return String(tourney.startFrom);
    case "set_open_time":
      return "18:00";
    case "set_open_days":
      return "";
    case "set_success_message":
      return tourney.successMessage ?? "";
    default:
      return "";
  }
}

/**
 * Flips a boolean field.
 *
 * **One column, one write.** The source's editor wrote the whole model.
 */
async function toggleField(
  interaction: ButtonInteraction,
  tourney: TourneyRecord,
  column: string,
): Promise<void> {
  const current = (tourney as unknown as Record<string, unknown>)[column];

  if (typeof current !== "boolean") {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  await repo.updateTourney(tourney.id, { [column]: !current });

  const fresh = await repo.getTourney(tourney.id);

  if (!fresh) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  await acknowledge(interaction);
  await renderPanel(interaction, await buildEditor(fresh));
}

/**
 * The refusal a premium field gives.
 *
 * @returns the message, or `null` when the guild holds the entitlement.
 */
export async function premiumRefusal(
  tourney: TourneyRecord,
  fieldKey: string,
): Promise<string | null> {
  try {
    await assertEntitled(tourney.guildId, PremiumFeature.tourneyFeatures);
  } catch (error) {
    logger.info(
      `[Tourneys] The "${fieldKey}" field is premium: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return error instanceof Error
      ? error.message
      : "This feature needs a premium entitlement.";
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

async function onLifecycle(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const what = parts[0];
  const tourneyId = parts[1];

  if (!what || !tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  if (what === "toggle") {
    if (tourney.status === "open") {
      const confirmed = await prompt(
        interaction,
        `Are you sure you want to pause the registrations of **${tourney.name}**?`,
      );

      if (!confirmed) {
        await renderPanel(interaction, buildTourneyPanel(tourney));

        return;
      }

      const paused = await pauseTourneyInGuild(guild, tourney.id);

      if (!paused) {
        await fail(interaction, "The tournament could not be paused.");

        return;
      }

      await renderPanel(interaction, buildTourneyPanel(paused));

      return;
    }

    const confirmed = await prompt(
      interaction,
      `Are you sure you want to open the registrations of **${tourney.name}**?`,
    );

    if (!confirmed) {
      await renderPanel(interaction, buildTourneyPanel(tourney));

      return;
    }

    const opened = await openTourneyInGuild(guild, tourney.id);

    if (!opened) {
      await fail(interaction, "The tournament could not be opened.");

      return;
    }

    await renderPanel(interaction, buildTourneyPanel(opened.tourney));

    return;
  }

  if (what === "close") {
    const confirmed = await prompt(
      interaction,
      `Are you sure you want to close the registrations of **${tourney.name}**?`,
    );

    if (!confirmed) {
      await renderPanel(interaction, buildTourneyPanel(tourney));

      return;
    }

    const closed = await closeTourneyInGuild(guild, tourney.id);

    if (!closed) {
      await fail(interaction, "The tournament could not be closed.");

      return;
    }

    await renderPanel(interaction, buildTourneyPanel(closed));
  }
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

async function onBan(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const copy = MODAL_COPY.ban;

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "ban", tourney.id),
      title: copy.title,
      label: copy.label,
      placeholder: copy.placeholder,
      required: copy.required,
      maxLength: copy.maxLength,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

async function onGroups(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];
  const page = parts[1];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const groups = await service.listGroups(tourney.id);

  if (groups.length === 0) {
    await fail(
      interaction,
      "There are no groups yet. Set the number of teams per group and let people register first.",
    );

    return;
  }

  const wanted = page && page !== "refresh" ? Number(page) : 1;
  const current = Math.min(
    Math.max(Number.isInteger(wanted) ? wanted : 1, 1),
    groups.length,
  );

  const categoryId = await findGroupCategory(interaction.guild, tourney);

  if (parts[2] === "role") {
    await giveGroupRole(interaction, current, groups);

    return;
  }

  await acknowledge(interaction);
  await renderPanel(
    interaction,
    buildGroupManagerPanel({ tourney, groups, current, categoryId }),
  );
}

/**
 * Gives a role to the members of a group.
 *
 * The source asked for the role with a message collector. Ours opens a
 * **role select menu** (D17): a role is not a modal input, and a modal
 * cannot hold one.
 */
async function giveGroupRole(
  interaction: ButtonInteraction,
  groupNumber: number,
  groups: readonly { number: number; slots: readonly { leaderId: string }[] }[],
): Promise<void> {
  const group = groups[groupNumber - 1];

  if (!group) {
    await fail(interaction, "That group does not exist.");

    return;
  }

  const [roleId] = await awaitRoleSelect(interaction, {
    placeholder: "Pick the role to give to the group",
  });

  if (!roleId) return;

  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const role = guild.roles.cache.get(roleId);

  if (!role) {
    await fail(interaction, "I could not find that role.");

    return;
  }

  let given = 0;

  for (const slot of group.slots) {
    const member = await guild.members.fetch(slot.leaderId).catch(() => null);

    if (!member) continue;
    if (member.roles.cache.has(role.id)) continue;

    const ok = await member.roles.add(role).catch(() => false);

    if (ok) given += 1;
  }

  await fail(
    interaction,
    `Done! The role was given to ${given} member(s) of group ${groupNumber}.`,
    { ok: true },
  );
}

/**
 * The category the group channels live in.
 *
 * The source found the channels by a **substring match** on the channel
 * name, so "Group 1" also matched "Group 10" (B15). Ours does not
 * rediscover anything: the channel a published list lives in is stored
 * on the `tourney_group_lists` row. The category is only shown so the
 * moderator can see where the channels are, and it is found by the exact
 * name the creation flow used.
 */
export async function findGroupCategory(
  guild: Guild | null,
  tourney: TourneyRecord,
): Promise<string | null> {
  if (!guild) return null;

  const name = `tourney-groups-${tourney.id}`;

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildCategory) continue;
    if (channel.name === name) return channel.id;
  }

  return null;
}

async function onGroupPublish(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];
  const groupNumber = Number(parts[1]);

  if (!tourneyId || !Number.isInteger(groupNumber)) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const groups = await service.listGroups(tourney.id);
  const group = groups[groupNumber - 1];

  if (!group) {
    await fail(interaction, "That group does not exist.");

    return;
  }

  const [channelId] = await awaitChannelSelect(interaction, {
    placeholder: "Pick the channel to publish the group list in",
  });

  if (!channelId) return;

  await publishGroupList(interaction, tourney, group, channelId);
}

/**
 * Publishes a group list and records it.
 *
 * The row carries the **channel**, so the Refresh button knows where the
 * list is without a substring match (D16 / B15).
 */
export async function publishGroupList(
  interaction: ButtonInteraction,
  tourney: TourneyRecord,
  group: { number: number; slots: readonly { num: number; teamName: string }[] },
  channelId: string,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const channel = guild.channels.cache.get(channelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    await fail(interaction, "I could not find that channel.");

    return;
  }

  const full = await service.listGroups(tourney.id);
  const whole = full[group.number - 1] ?? group;

  const panel = buildPublishedGroupList({
    tourney,
    group: whole as Parameters<typeof buildPublishedGroupList>[0]["group"],
    guildName: guild.name,
  });

  const message = await channel
    .send({ embeds: panel.embeds, components: panel.components })
    .catch(() => null);

  if (!message) {
    await fail(interaction, "The group list could not be published.");

    return;
  }

  await repo.upsertGroupList({
    tourneyId: tourney.id,
    messageId: message.id,
    channelId,
    groupNumber: group.number,
  });

  await fail(interaction, "The group list was published.", { ok: true });
}

async function onGroupRefresh(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];
  const groupNumber = Number(parts[1]);
  const wantInfo = parts[2] === "info";

  if (!tourneyId || !Number.isInteger(groupNumber)) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const record = await repo.getGroupList(tourney.id, groupNumber);

  if (!record) {
    await fail(interaction, "That group list is no longer published.");

    return;
  }

  const groups = await service.listGroups(tourney.id);
  const group = groups[groupNumber - 1];

  if (!group) {
    await fail(interaction, "That group no longer exists.");

    return;
  }

  if (wantInfo) {
    const options = group.slots.map((slot) => ({
      label: `Slot ${slot.num} — ${slot.teamName}`.slice(0, 100),
      value: slot.id,
    }));

    if (options.length === 0) {
      await fail(interaction, "That group is empty.");

      return;
    }

    const chosen = await awaitSelect(interaction, options, {
      placeholder: "Select the slot to see the team info.",
      ephemeral: true,
    });

    const slotId = chosen[0];

    if (!slotId) return;

    const slot = await repo.getSlot(slotId);

    if (!slot) {
      await fail(interaction, "That slot no longer exists.");

      return;
    }

    const embed = panelEmbed({
      title: "Slot details",
      description: [
        `> Team name: \`${slot.teamName}\``,
        `> Team leader: <@${slot.leaderId}>`,
        `> Registration message: [Click here](${slot.jumpUrl ?? "—"})`,
        `> Confirm message: [Click here](${slot.confirmJumpUrl ?? "—"})`,
      ].join("\n"),
    });

    await interaction.followUp({ embeds: [embed], ephemeral: true });

    return;
  }

  // The two-minute cooldown. The timestamp is written **only** by this
  // path (B16), so it depends on the refresh and on nothing else.
  const since = Date.now() - record.updatedAt.getTime();

  if (since < GROUP_REFRESH_COOLDOWN_MS) {
    await fail(interaction, "You can only refresh every 2 minutes.");

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const channel = guild.channels.cache.get(record.channelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    await fail(interaction, "The channel of that group list is gone.");

    return;
  }

  const panel = buildPublishedGroupList({
    tourney,
    group,
    guildName: guild.name,
  });

  const message = await channel.messages
    .fetch(record.messageId)
    .catch(() => null);

  if (!message) {
    await fail(interaction, "The group list message is gone.");

    return;
  }

  await message.edit({ embeds: panel.embeds, components: panel.components });

  await repo.touchGroupList(record.id);

  await fail(interaction, "The group list was refreshed.", { ok: true });
}

/* ------------------------------------------------------------------ *
 * The slot manager
 * ------------------------------------------------------------------ */

async function onSlotManager(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  if (parts[1] !== "info") {
    await acknowledge(interaction);
    await renderPanel(interaction, buildSlotManagerPanel(tourney));

    return;
  }

  const slots = await repo.listSlotsOfUser(tourney.id, interaction.user.id);

  if (slots.length === 0) {
    await fail(
      interaction,
      "You do not have a slot in this tournament, because you have not registered in it yet.",
    );

    return;
  }

  const groups = await service.listGroups(tourney.id);

  const groupNumbers = slots.map((slot) => {
    for (const group of groups) {
      if (group.slots.some((entry) => entry.id === slot.id)) return group.number;
    }

    return 0;
  });

  const embed = panelEmbed({
    title: "Your slots",
    description: `You have the following slots in **${tourney.name}**:\n\n${slots
      .map(
        (slot, index) =>
          `\`${index + 1}.\` **${slot.teamName}** (Slot ${slot.num}, Group ${groupNumbers[index] ?? "?"})`,
      )
      .join("\n")}`,
  });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function onSlotCancel(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const slotId = parts[1];

  if (!slotId) {
    const slots = await repo.listSlotsOfUser(tourney.id, interaction.user.id);

    if (slots.length === 0) {
      await fail(
        interaction,
        "You do not have a slot in this tournament, because you have not registered in it yet.",
      );

      return;
    }

    const picked = await awaitSelect(
      interaction,
      slots.slice(0, 25).map((slot) => ({
        label: `Slot ${slot.num} — ${slot.teamName}`.slice(0, 100),
        value: slot.id,
        description: `Group slot ${slot.num}`.slice(0, 100),
      })),
      {
        maxValues: 1,
        placeholder: "Select the slot to cancel",
        question: "Select the slot to cancel.",
        ephemeral: true,
      },
    );

    const pickedId = picked[0];

    if (!pickedId) return;

    await cancelSlot(interaction, tourney, pickedId);

    return;
  }

  await cancelSlot(interaction, tourney, slotId);
}

/** Cancels a slot, striking the confirmation and dropping the role. */
async function cancelSlot(
  interaction: ButtonInteraction,
  tourney: TourneyRecord,
  slotId: string,
): Promise<void> {
  const slot = await repo.getSlot(slotId);

  if (!slot || slot.tourneyId !== tourney.id) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  const confirmed = await prompt(
    interaction,
    "Are you sure you want to cancel your slot?",
    {
      // The button press has already been answered by the menu, so the
      // question has to be a follow-up.
      asFollowUp: true,
      ephemeral: true,
    },
  );

  if (!confirmed) {
    await fail(interaction, "Alright, aborting.");

    return;
  }

  await service.removeSlot(tourney.id, slot.id);

  const guild = interaction.guild;

  if (guild) {
    await strikeConfirmMessage(guild, slot.confirmJumpUrl);
  }

  // The rule the source had: only remove the role when this was their
  // last slot.
  if (!(await service.hasOtherSlot(tourney.id, slot.leaderId, slot.id))) {
    if (guild) {
      await removeSuccessRole(guild, tourney, slot.leaderId);
    }
  }

  await fail(interaction, "✅ | Your slot was removed.", { ok: true });
}

async function onSlotRename(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const slotId = parts[1];

  if (!slotId) {
    const slots = await repo.listSlotsOfUser(tourney.id, interaction.user.id);

    if (slots.length === 0) {
      await fail(
        interaction,
        "You do not have a slot in this tournament, because you have not registered in it yet.",
      );

      return;
    }

    // The menu is **persistent**, and that is the point: a modal can
    // only be shown on an interaction that has not been answered yet,
    // and `core/select.ts`'s `awaitSelect` answers the select
    // interaction it opens. A menu that is waited on inline therefore
    // cannot be followed by a modal.
    //
    // This one is a real component in a message, so the member's pick
    // arrives as an interaction of its own — still unanswered — and the
    // rename modal can be shown from it. See `select-handlers.ts`.
    //
    // The custom id carries the tournament and the member who opened
    // the menu (D18), so the handler knows whose slots are on offer and
    // refuses a pick from anybody else.
    const menu = new StringSelectMenuBuilder()
      .setCustomId(tourneysId("slotm_pick", tourney.id, interaction.user.id))
      .setPlaceholder("Select the slot to rename")
      .setMinValues(1)
      .setMaxValues(1);

    for (const slot of slots.slice(0, 25)) {
      menu.addOptions({
        label: `Slot ${slot.num} — ${slot.teamName}`.slice(0, 100),
        value: slot.id,
      });
    }

    await respond(interaction, { components: [componentRow(menu)] }, true);

    return;
  }

  await openRenameModal(interaction, tourney, slotId);
}

/**
 * Opens the rename modal.
 *
 * **A modal, not a chat-message collector.** The source granted the user
 * temporary `send_messages` in the channel and waited for their next
 * message, which anybody could have hijacked (D17).
 */
async function openRenameModal(
  interaction: ButtonInteraction,
  tourney: TourneyRecord,
  slotId: string,
): Promise<void> {
  const copy = MODAL_COPY.rename;

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "rename", tourney.id, slotId),
      title: copy.title,
      label: copy.label,
      placeholder: copy.placeholder,
      required: copy.required,
      maxLength: copy.maxLength,
    }),
  );
}

async function onSlotSwap(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const member = interaction.guild?.members.cache.get(interaction.user.id);

  const allowed =
    member?.permissions.has(PermissionFlagsBits.ManageGuild) === true ||
    member?.permissions.has(PermissionFlagsBits.Administrator) === true;

  if (!allowed) {
    await fail(
      interaction,
      "You need the **Manage Server** permission to swap groups.",
    );

    return;
  }

  const slots = await repo.listSlots(tourney.id);

  if (slots.length < 2) {
    await fail(interaction, "There are not enough slots to swap.");

    return;
  }

  // A **modal**, not two select menus: `awaitSelect` opens a component
  // collector on the reply, and a reply can only carry one. The second
  // menu would have had nothing to wait on.
  const copy = TWO_INPUT_COPY.swap;

  await interaction.showModal(
    buildTwoInputModal({
      customId: tourneysId("modal", "swap", tourney.id),
      title: copy.title,
      first: {
        id: "first",
        label: copy.first.label,
        placeholder: copy.first.placeholder,
      },
      second: {
        id: "second",
        label: copy.second.label,
        placeholder: copy.second.placeholder,
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Media partners
 * ------------------------------------------------------------------ */

async function onPartner(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const partners = await repo.listMediaPartners(tourney.id);

  const withCounts = await Promise.all(
    partners.map(async (partner) => ({
      ...partner,
      playerCount: await repo.countMediaPartnerSlots(partner.id),
    })),
  );

  await acknowledge(interaction);
  await renderPanel(
    interaction,
    buildPartnerPanel({ tourney, partners: withCounts }),
  );
}

async function onPartnerAdd(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const copy = MODAL_COPY.partner_add;

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "partner_add", tourney.id),
      title: copy.title,
      label: copy.label,
      placeholder: copy.placeholder,
      required: copy.required,
      maxLength: copy.maxLength,
    }),
  );
}

async function onPartnerRemove(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const partners = await repo.listMediaPartners(tourney.id);

  if (partners.length === 0) {
    await fail(interaction, "This tournament has no media partners.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    partners.map((partner) => ({
      label: `Partner channel ${partner.channelId}`.slice(0, 100),
      value: partner.channelId,
    })),
    { placeholder: "Select the partner to remove", ephemeral: true },
  );

  const channelId = chosen[0];

  if (!channelId) return;

  await service.removeMediaPartner(tourney.id, channelId);

  await onPartner(interaction, [tourney.id]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Runs a background job without letting it crash the process. */
export function background(fn: () => Promise<unknown>, label: string): void {
  run(fn, label);
}

/** Parses a comma-separated list of weekdays. */
export { parseOpenDays };
