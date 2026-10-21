/**
 * The slot manager: setting one up, and editing it.
 *
 * A slot manager is a channel with a public panel in it. Setting one up
 * creates the channel, posts the panel and records the scrims it shows.
 *
 * The editor has five buttons and a delete, as in the source:
 *
 *  - **A — Main Channel.** A deliberate stub in the source: it answers
 *    "Main Channel can't be edited. Sorry 🥲" and does nothing else. The
 *    port keeps the stub and the message; there is no channel-rename
 *    flow.
 *  - **B — Slot-m Status.** The panel's on/off switch.
 *  - **C — Reminders button.** Whether "Remind Me" is offered.
 *  - **D — Multi Slot-Claim.** Whether one member may hold more than one
 *    slot in a scrim.
 *  - **E — Scrims.** Which scrims the panel shows.
 *  - **Delete Slot-M.** Removes the manager and disables the panel.
 */

import { ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  TextChannel,
} from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { respond, replyError, replySuccess } from "../../../core/context.js";
import { awaitSelect } from "../../../core/select.js";
import { prompt } from "../../../core/prompt.js";
import { isStaff } from "../../../core/guards.js";
import { plural } from "../../../core/text.js";
import { freeTierLimit } from "../../../core/premium.js";
import { PremiumFeature } from "../../../core/premium.js";
import { assertEntitled } from "../../premium/index.js";
import { buildPremiumGate, gateReason } from "../../premium/gate.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotsId } from "../ids.js";
import type { SlotManagerRecord } from "../types.js";
import { assertComponentBudget, button, buttonRow } from "./components.js";
import {
  buildPublicEmbed,
  buildPublicRows,
  refreshPublicMessage,
} from "./panel.js";

/**
 * The message the source's "Main Channel" button answered with.
 *
 * The button is a deliberate stub: the source told the moderator to
 * rename the channel themselves. There is no rename flow here either.
 */
export const MAIN_CHANNEL_EDIT_MESSAGE = "Main Channel can't be edited. Sorry 🥲";

/** The name of the channel a slot manager creates. */
export const SLOT_MANAGER_CHANNEL_NAME = "cancel-claim-slot";

/**
 * The editor's embed.
 *
 * The source's field layout, with the letters it used.
 */
export function buildManagerEmbed(
  manager: SlotManagerRecord,
  scrimCount: number,
): EmbedBuilder {
  const fields: { name: string; value: string }[] = [
    { name: "A — Main Channel:", value: `<#${manager.mainChannelId}>` },
    {
      name: "B — Slot-m Status:",
      value: manager.toggle ? "Enabled" : "Disabled",
    },
    {
      name: "C — Reminders button:",
      value: manager.allowReminders ? "Enabled" : "Disabled",
    },
    {
      name: "D — Multi Slot-Claim:",
      value: manager.multipleSlots ? "Enabled" : "Disabled",
    },
    {
      name: "E — Scrims:",
      value: `${plural(scrimCount, "scrim")} (\`Click to edit\`)`,
    },
  ];

  const embed = new EmbedBuilder()
    .setTitle("Slot-M Editor")
    .setColor(EMBED_COLOR);

  embed.addFields(
    fields.map((field) => ({
      name: field.name,
      value: field.value,
      inline: false,
    })),
  );

  embed.addFields({
    name: "🟥 Delete Slot-M",
    value: "`Click to delete`",
    inline: false,
  });

  return embed;
}

/** The editor's buttons. */
export function buildManagerRows(
  manager: SlotManagerRecord,
): ReturnType<typeof buttonRow>[] {
  const rows = [
    buttonRow(
      button({
        customId: slotsId("manager_channel", manager.id),
        label: "A",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: slotsId("manager_toggle", manager.id),
        label: "B",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: slotsId("manager_reminders", manager.id),
        label: "C",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: slotsId("manager_multi", manager.id),
        label: "D",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: slotsId("manager_scrims", manager.id),
        label: "E",
        style: ButtonStyle.Primary,
      }),
    ),
    buttonRow(
      button({
        customId: slotsId("manager_delete", manager.id),
        label: "Delete Slot-Manager",
        style: ButtonStyle.Danger,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return rows;
}

/** The scrims sub-panel's buttons. */
export function buildManagerScrimsRows(
  manager: SlotManagerRecord,
): ReturnType<typeof buttonRow>[] {
  const rows = [
    buttonRow(
      button({
        customId: slotsId("manager_scrims_add", manager.id),
        label: "➕ Add scrims",
        style: ButtonStyle.Success,
      }),
      button({
        customId: slotsId("manager_scrims_remove", manager.id),
        label: "➖ Remove scrims",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: slotsId("manager_toggle", manager.id),
        label: "Back",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return rows;
}

/** The scrims sub-panel's embed. */
export function buildManagerScrimsEmbed(
  scrimIds: readonly string[],
): EmbedBuilder {
  const list =
    scrimIds.length > 0
      ? scrimIds.map((id) => `\`${id}\``).join(", ")
      : "*none*";

  return new EmbedBuilder()
    .setTitle("Slot-M Editor — scrims")
    .setColor(EMBED_COLOR)
    .setDescription(
      `Do you want to add scrims or remove scrims from this slot-m?\n\nCurrent scrims: ${list}`,
    );
}

/**
 * The refusal a non-moderator gets.
 *
 * The manager's editor is a panel with buttons, and the panel may be
 * seen by anybody who can read the channel it is in. The source showed
 * the editor as an ephemeral message to the moderator who asked for it,
 * so only they could ever press a button; here the panel is public, so
 * the buttons check the caller themselves.
 */
export const SLOT_MANAGER_DENIAL_MESSAGE =
  "You need the **scrims-mod** role or **Manage Server** permissions to manage a slot-manager.";

/**
 * May the caller manage a slot manager?
 *
 * The source's rule: `manage_guild`, or a role called `scrims-mod`.
 * The staff role and the Administrator permission pass as well, because
 * the dispatcher uses the same check for the command.
 */
export async function canManageSlotManager(
  interaction: ButtonInteraction,
): Promise<string | null> {
  const guild = interaction.guild;

  if (!guild) return "This only works in a server.";

  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member) return SLOT_MANAGER_DENIAL_MESSAGE;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  if (
    member.roles.cache.some(
      (role) => role.name.trim().toLowerCase() === "scrims-mod",
    )
  ) {
    return null;
  }

  if (await isStaff(interaction)) return null;

  return SLOT_MANAGER_DENIAL_MESSAGE;
}

/* ------------------------------------------------------------------ *
 * The buttons
 * ------------------------------------------------------------------ */

/**
 * Handles one of the manager editor's buttons.
 *
 * @param action the action from the custom id.
 * @param managerId the slot manager the editor belongs to.
 */
export async function handleManagerButton(
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

  const refusal = await canManageSlotManager(interaction);

  if (refusal) {
    await replyError(interaction, refusal, { ephemeral: true });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === "manager_channel") {
    // The deliberate stub, ported with the same message.
    await respond(interaction, { content: MAIN_CHANNEL_EDIT_MESSAGE });
    return;
  }

  if (action === "manager_toggle") {
    await repo.updateSlotManager(manager.id, { toggle: !manager.toggle });
    await showEditor(interaction, manager.id);
    return;
  }

  if (action === "manager_reminders") {
    await repo.updateSlotManager(manager.id, {
      allowReminders: !manager.allowReminders,
    });
    await showEditor(interaction, manager.id);
    return;
  }

  if (action === "manager_multi") {
    await repo.updateSlotManager(manager.id, {
      multipleSlots: !manager.multipleSlots,
    });
    await showEditor(interaction, manager.id);
    return;
  }

  if (action === "manager_scrims") {
    const scrimIds = await repo.listSlotManagerScrimIds(manager.id);

    await respond(interaction, {
      embeds: [buildManagerScrimsEmbed(scrimIds)],
      components: buildManagerScrimsRows(manager),
    });

    return;
  }

  if (action === "manager_scrims_add") {
    await addScrims(interaction, manager);
    return;
  }

  if (action === "manager_scrims_remove") {
    await removeScrims(interaction, manager);
    return;
  }

  if (action === "manager_delete") {
    await deleteManager(interaction, manager);
    return;
  }

  await replyError(interaction, "That button is no longer active.", {
    ephemeral: true,
  });
}

/** Shows the editor for a manager. */
async function showEditor(
  interaction: ButtonInteraction,
  managerId: string,
): Promise<void> {
  const manager = await repo.getSlotManager(managerId);

  if (!manager) {
    await replyError(interaction, "This slot manager no longer exists.");
    return;
  }

  const scrimIds = await repo.listSlotManagerScrimIds(manager.id);

  await respond(interaction, {
    embeds: [buildManagerEmbed(manager, scrimIds.length)],
    components: buildManagerRows(manager),
  });
}

/** Adds scrims to a manager. */
async function addScrims(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await replyError(interaction, "This only works in a server.");
    return;
  }

  const all = await repo.listScrims(manager.guildId);

  const taken = new Set(await repo.listSlotManagerScrimIds(manager.id));

  const available = all.filter((scrim) => !taken.has(scrim.id));

  if (available.length === 0) {
    await replyError(
      interaction,
      "All scrims are already added to this or another slot-m.",
    );

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    available.slice(0, 25).map((scrim) => ({
      label: `#${scrim.name}`.slice(0, 100),
      value: scrim.id,
      description: scrim.registrationChannelId.slice(0, 100),
      emoji: "📇",
    })),
    {
      maxValues: Math.min(available.length, 25),
      placeholder: "Select scrims to add to this slot-manager ...",
      question: "Choose the scrims you want to add to this slotm.",
    },
  );

  if (chosen.length === 0) return;

  const current = await repo.listSlotManagerScrimIds(manager.id);

  await repo.setSlotManagerScrims(manager.id, [...current, ...chosen]);

  await refreshPublicMessage(interaction.client, manager.id);

  await replySuccess(interaction, "Successfully added new scrims.");
}

/** Removes scrims from a manager. */
async function removeScrims(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  const current = await repo.listSlotManagerScrimIds(manager.id);

  if (current.length === 0) {
    await replyError(interaction, "There are no scrims added to this slot-m.");
    return;
  }

  const chosen = await awaitSelect(
    interaction,
    current.slice(0, 25).map((id) => ({
      label: `\`${id}\``.slice(0, 100),
      value: id,
      emoji: "📇",
    })),
    {
      maxValues: Math.min(current.length, 25),
      placeholder: "Select scrims to remove from this slot-manager ...",
      question: "Choose the scrims you want to remove from this slotm.",
    },
  );

  if (chosen.length === 0) return;

  const kept = current.filter((id) => !chosen.includes(id));

  await repo.setSlotManagerScrims(manager.id, kept);

  await refreshPublicMessage(interaction.client, manager.id);

  await replySuccess(interaction, "Successfully removed selected scrims.");
}

/** Deletes a manager. */
async function deleteManager(
  interaction: ButtonInteraction,
  manager: SlotManagerRecord,
): Promise<void> {
  const confirmed = await prompt(
    interaction,
    "Are you sure you want to delete this Slot-Manager?",
  );

  if (!confirmed) {
    await respond(interaction, { content: "Alright, Aborting." });
    return;
  }

  await repo.deleteSlotManager(manager.id);

  await replySuccess(interaction, "Slot-M Deleted.");
}

/* ------------------------------------------------------------------ *
 * The setup
 * ------------------------------------------------------------------ */

/**
 * The refusal the setup gives when the guild has no more slot managers
 * than the free tier allows.
 */
export async function slotManagerLimitRefusal(
  guildId: string,
): Promise<string | null> {
  const limit = freeTierLimit("slotManagers");

  if (limit === null) return null;

  const current = await repo.countSlotManagers(guildId);

  if (current < limit) return null;

  try {
    await assertEntitled(guildId, PremiumFeature.extraChannels);
    return null;
  } catch {
    return `You can only have ${limit} slot manager on this server. You already have ${current}.`;
  }
}

/**
 * Sets a slot manager up.
 *
 * The scrims are picked, the moderator confirms, the channel is created
 * and the public panel is posted in it.
 */
export async function runSetup(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await replyError(interaction, "This only works in a server.");
    return;
  }

  const refusal = await slotManagerLimitRefusal(guild.id);

  if (refusal) {
    const feature = PremiumFeature.extraChannels;

    try {
      await assertEntitled(guild.id, feature);
    } catch {
      const gate = buildPremiumGate(gateReason(feature));

      await respond(interaction, {
        embeds: [gate.embed],
        components: gate.components,
      });

      return;
    }

    await replyError(interaction, refusal);
    return;
  }

  const all = await repo.listScrims(guild.id);

  const taken = new Set<string>();

  for (const manager of await repo.listSlotManagers(guild.id)) {
    for (const id of await repo.listSlotManagerScrimIds(manager.id)) {
      taken.add(id);
    }
  }

  const available = all.filter((scrim) => !taken.has(scrim.id));

  if (available.length === 0) {
    await replyError(
      interaction,
      "There are no scrims available for a new slotmanager channel.\n\nIf you have other slot-m channel, first remove the scrims from that channel to add them to new slot-m.",
    );

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    available.slice(0, 25).map((scrim) => ({
      label: `#${scrim.name}`.slice(0, 100),
      value: scrim.id,
      description: scrim.registrationChannelId.slice(0, 100),
      emoji: "📇",
    })),
    {
      maxValues: Math.min(available.length, 25),
      placeholder: "Select scrims to add to slot-manager ...",
      question:
        "Choose 1 or multiple scrims that you want to add to new slot-manager.\n\n`If a scrim isn't in the dropdown that means it has been added to another slotm.`",
    },
  );

  if (chosen.length === 0) return;

  const confirmed = await prompt(
    interaction,
    "A new channel will be created for the selected scrims slot manager.\n\n`Do you want to continue?`",
  );

  if (!confirmed) {
    await respond(interaction, { content: "Alright, Aborting." });
    return;
  }

  const channel = await createSlotManagerChannel(guild, interaction.user.username);

  if (!channel) {
    await replyError(
      interaction,
      "I could not create the slot-manager channel. Do I have the **Manage Channels** permission?",
    );

    return;
  }

  const manager = await repo.createSlotManager({
    guildId: guild.id,
    mainChannelId: channel.id,
    messageId: "0",
  });

  await repo.setSlotManagerScrims(manager.id, chosen);

  const claimable = await service.listClaimableScrims(repo.slotStore, manager.id);

  const message = await channel.send({
    embeds: [buildPublicEmbed(claimable)],
    components: buildPublicRows(manager, claimable),
  });

  await repo.updateSlotManager(manager.id, { messageId: message.id });

  await replySuccess(
    interaction,
    `Successfully setup slotm for selected scrims in ${channel.toString()}.\n\n` +
      "`You can rename this channel if you want to.`",
  );
}

/**
 * Creates the slot manager's channel.
 *
 * The channel is read-only for everybody: the members read the panel,
 * the bot is the only one who writes in it. The source let the
 * moderators rename the channel themselves, which is why the editor's
 * "Main Channel" button is a stub.
 */
export async function createSlotManagerChannel(
  guild: Guild,
  invoker: string,
): Promise<TextChannel | null> {
  const me = guild.members.me;

  if (!me) return null;

  try {
    return await guild.channels.create({
      name: SLOT_MANAGER_CHANNEL_NAME,
      reason: `Created for Scrims Slot Management by ${invoker}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          deny: [PermissionFlagsBits.SendMessages],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ],
    });
  } catch {
    return null;
  }
}
