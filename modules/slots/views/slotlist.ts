/**
 * The published slot list and its Edit / Punish / Info panel.
 *
 * The slot list is a message in the scrim's slotlist channel. It has to
 * survive a restart, so the custom id carries the **scrim id** (D18) and
 * the message id lives on the scrim row.
 *
 * Three buttons, as in the source:
 *
 *  - **Edit** — change, add or remove a team;
 *  - **Punish** — ban the teams of the chosen slots;
 *  - **Info** — who is in a slot.
 *
 * Two things are fixed here rather than ported:
 *
 *  - the punish flow asked for a free-text reason with a chat-message
 *    collector and a four-keycap button row for the ban type. The keycap
 *    row had no stable custom id, so the ban type could not be routed.
 *    Ours asks for the reason in a **modal** and the ban type in a
 *    **select menu** (D17);
 *  - the "Add Team" button offered `range(start_from, 30)` — a
 *    hard-coded thirty that ignored `total_slots` and offered numbers
 *    the scrim did not have (B4). Ours offers the scrim's own numbers.
 */

import { ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import type {
  ActionRowBuilder,
  AnySelectMenuInteraction,
  ButtonBuilder,
  ButtonInteraction,
  Client,
  Guild,
  Message,
  TextChannel,
} from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { respond, replyError, replySuccess } from "../../../core/context.js";
import { plural, truncate } from "../../../core/text.js";
import { logger } from "../../../utils/logger.js";
import { writeBanLogs } from "../ban-log.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotsId } from "../ids.js";
import { BAN_MODES, BAN_MODE_LABELS, BanMode } from "../types.js";
import type { ScrimLite, SlotRecord } from "../types.js";
import {
  assertComponentBudget,
  buildModal,
  button,
  buttonRow,
} from "./components.js";
import { addScrimRole, removeScrimRole } from "./helpers.js";
import { refreshPublicMessage } from "./panel.js";
import { clearPickMenu, issueModalToken, showPick } from "./pick.js";
import type { PickContext } from "./pick.js";

/**
 * The refusal a non-moderator gets.
 *
 * The source checked `manage_guild`, or a role called `scrims-mod`.
 */
export const SLOT_LIST_DENIAL_MESSAGE =
  "You need the **scrims-mod** role or **Manage Server** permissions to edit this slotlist.";

/**
 * The parts of a slot the slot list shows.
 *
 * Structural on purpose: the scrims area's `SlotRecord` is a different
 * type with the same fields, and the published slot list has **one**
 * implementation of what it looks like (see `modules/slots/slotlist.ts`).
 */
export interface SlotListSlot {
  readonly num: number;
  readonly state: string;
  readonly teamName: string | null;
  readonly ownerUserId: string | null;
}

/**
 * The slot list's body.
 *
 * A plain list of the claimed slots. The message is edited in place, so
 * the list is always the current one.
 */
export function buildSlotListEmbed(
  scrim: { readonly name: string },
  slots: readonly SlotListSlot[],
): EmbedBuilder {
  const claimed = slots.filter((slot) => slot.state === "claimed");

  const body =
    claimed.length === 0
      ? "No team has registered yet."
      : claimed
          .map(
            (slot) =>
              `${slot.num}. ${slot.teamName ?? "—"} ${slot.ownerUserId ? `<@${slot.ownerUserId}>` : ""}`.trim(),
          )
          .join("\n");

  return new EmbedBuilder()
    .setTitle(`Slotlist — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(body);
}

/**
 * The slot list's buttons.
 *
 * The custom ids carry the scrim id, so the panel keeps working after a
 * restart, a move or an edit.
 *
 * The buttons are the **slot area's**: `slots:slotlist_*`. There is one
 * namespace for these buttons across the bot, and it is this one.
 */
export function buildSlotListRows(
  scrimId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows = [
    buttonRow(
      button({
        customId: slotsId("slotlist_edit", scrimId),
        label: "Edit",
        emoji: "📝",
        style: ButtonStyle.Success,
      }),
      button({
        customId: slotsId("slotlist_punish", scrimId),
        label: "Punish",
        emoji: "🛠️",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: slotsId("slotlist_info", scrimId),
        label: "Info",
        emoji: "🧐",
        style: ButtonStyle.Success,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return rows;
}

/**
 * The slot list's editor.
 *
 * Three operations, as in the source: change a team, remove a team, add
 * a team.
 */
export function buildSlotListEditorRows(
  scrimId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows = [
    buttonRow(
      button({
        customId: slotsId("slotlist_change", scrimId),
        label: "Change Team",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: slotsId("slotlist_remove", scrimId),
        label: "Remove Team",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: slotsId("slotlist_add", scrimId),
        label: "Add Team",
        style: ButtonStyle.Success,
      }),
      button({
        customId: slotsId("slotlist_edit", scrimId),
        label: "Back",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return rows;
}

/** The editor's embed. */
export function buildSlotListEditorEmbed(scrim: ScrimLite): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Edit the slotlist — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription("Choose an option below to edit the slotlist.");
}

/**
 * Sends the slot list into a channel.
 *
 * The message carries the Edit / Punish / Info panel, so it keeps
 * working after a restart: the custom id names the scrim, and the scrim
 * row names the message.
 *
 * This is the **one** implementation of what a published slot list looks
 * like. The area's public API (`modules/slots/slotlist.ts`) is the only
 * way in, so nobody can publish a slot list that looks different.
 *
 * @returns the id of the message that was sent.
 */
export async function sendSlotListMessage(
  channel: TextChannel,
  scrim: ScrimLite,
  slots: readonly SlotRecord[],
): Promise<string> {
  const message = await channel.send({
    embeds: [buildSlotListEmbed(scrim, slots)],
    components: buildSlotListRows(scrim.id),
  });

  return message.id;
}

/**
 * Re-renders a published slot list message.
 *
 * The body and the buttons are rebuilt from the scrim and its slots, so
 * the message is always the current list. A message that cannot be
 * edited — deleted, or the bot lost the permission — is left alone
 * rather than turned into a crash.
 */
export async function renderSlotListMessage(
  message: Message,
  scrim: ScrimLite,
  slots: readonly SlotRecord[],
): Promise<void> {
  await message
    .edit({
      embeds: [buildSlotListEmbed(scrim, slots)],
      components: buildSlotListRows(scrim.id),
    })
    .catch(() => undefined);
}

/**
 * How many channels are looked at when the published message is not in
 * the scrim's own slotlist channel.
 */
const MAX_SCANNED_CHANNELS = 10;

/**
 * The published message, found by its id.
 *
 * The scrim's own slotlist channel is where the message is, unless it
 * was published somewhere else — so the guild's other channels are
 * looked at too, but only after the obvious place has failed.
 *
 * The scan is **bounded**: a guild with a hundred channels would cost a
 * hundred API calls for a message that is simply gone, and a refresh
 * that finds nothing is a no-op anyway.
 */
export async function findSlotListMessage(
  client: Client,
  scrim: ScrimLite,
  messageId: string,
): Promise<Message | null> {
  const guild = client.guilds.cache.get(scrim.guildId);

  if (!guild) return null;

  const channel = guild.channels.cache.get(scrim.slotlistChannelId);

  if (channel && "messages" in channel) {
    const message = await channel.messages
      .fetch(messageId)
      .catch(() => null);

    if (message) return message;
  }

  const channels = await guild.channels.fetch().catch(() => null);

  if (!channels) return null;

  let scanned = 0;

  for (const other of channels.values()) {
    if (!other) continue;
    if (other.id === scrim.slotlistChannelId) continue;
    if (!("messages" in other)) continue;

    scanned += 1;

    if (scanned > MAX_SCANNED_CHANNELS) break;

    const message = await other.messages.fetch(messageId).catch(() => null);

    if (message) return message;
  }

  return null;
}

/**
 * Refreshes the published slot list message.
 *
 * The message id is on the scrim row, so the message is found again
 * after a restart without anybody rediscovering it by name.
 */
export async function refreshScrimSlotlist(
  client: Client,
  scrimId: string,
): Promise<void> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim?.slotlistMessageId) return;

  const message = await findSlotListMessage(
    client,
    scrim,
    scrim.slotlistMessageId,
  );

  if (!message) return;

  const slots = await repo.listSlots(scrim.id);

  await renderSlotListMessage(message, scrim, slots);
}

/* ------------------------------------------------------------------ *
 * The buttons
 * ------------------------------------------------------------------ */

/**
 * Handles one of the slot list's buttons.
 *
 * @param action the action from the custom id.
 * @param scrimId the scrim the panel belongs to.
 */
export async function handleSlotListButton(
  interaction: ButtonInteraction,
  action: string,
  scrimId: string | null,
): Promise<void> {
  if (!scrimId) {
    await replyError(interaction, "That button is no longer active.", {
      ephemeral: true,
    });

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await replyError(interaction, "This scrim no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  const refusal = await canEditSlotList(interaction);

  if (refusal) {
    await replyError(interaction, refusal, { ephemeral: true });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === "slotlist_edit") {
    await respond(interaction, {
      embeds: [buildSlotListEditorEmbed(scrim)],
      components: buildSlotListEditorRows(scrim.id),
    });

    return;
  }

  if (action === "slotlist_add") {
    await startAddTeam(interaction, scrim);
    return;
  }

  if (action === "slotlist_change") {
    await startChangeTeam(interaction, scrim);
    return;
  }

  if (action === "slotlist_remove") {
    await startRemoveTeam(interaction, scrim);
    return;
  }

  if (action === "slotlist_punish") {
    await startPunish(interaction, scrim);
    return;
  }

  if (action === "slotlist_info") {
    await startInfo(interaction, scrim);
    return;
  }

  await replyError(interaction, "That button is no longer active.", {
    ephemeral: true,
  });
}

/**
 * May the caller edit the slot list?
 *
 * The source's rule: `manage_guild`, or a role called `scrims-mod`.
 */
export async function canEditSlotList(
  interaction: ButtonInteraction,
): Promise<string | null> {
  const guild = interaction.guild;

  if (!guild) return "This only works in a server.";

  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member) return SLOT_LIST_DENIAL_MESSAGE;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  if (
    member.roles.cache.some(
      (role) => role.name.trim().toLowerCase() === "scrims-mod",
    )
  ) {
    return null;
  }

  return SLOT_LIST_DENIAL_MESSAGE;
}

/* ------------------------------------------------------------------ *
 * The flows
 * ------------------------------------------------------------------ */

/**
 * "Add Team": pick the slot, then write the team.
 *
 * The numbers offered are the scrim's **own** numbers, from
 * `start_from` to `start_from + total_slots - 1` (B4) — the source
 * hard-coded thirty and offered numbers the scrim did not have.
 */
async function startAddTeam(
  interaction: ButtonInteraction,
  scrim: ScrimLite,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);

  const taken = new Set(
    slots.filter((slot) => slot.state !== "free").map((slot) => slot.num),
  );

  const numbers = service
    .slotNumbersOf(scrim)
    .filter((num) => !taken.has(num));

  if (numbers.length === 0) {
    await replyError(interaction, "No slots available to add this time.");
    return;
  }

  const context: PickContext = { kind: "add_team", scrimId: scrim.id };

  await showPick(
    interaction,
    numbers.slice(0, 25).map((num) => ({
      label: `Slot ${num}`.slice(0, 100),
      value: String(num),
      emoji: "📇",
    })),
    context,
    {
      placeholder: "Select the slot to add...",
      question: "Kindly choose a slot from the dropdown.",
      ephemeral: true,
    },
  );
}

/** "Change Team": pick the slot, then write the team. */
async function startChangeTeam(
  interaction: ButtonInteraction,
  scrim: ScrimLite,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);

  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await replyError(interaction, "No slot available to replace.");
    return;
  }

  const context: PickContext = { kind: "change_team", scrimId: scrim.id };

  await showPick(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: truncate(slot.teamName ?? "—", 40),
      emoji: "📇",
    })),
    context,
    {
      placeholder: "Select the slot to change...",
      question: "Kindly choose a slot from the dropdown.",
      ephemeral: true,
    },
  );
}

/** "Remove Team": pick the slot. No form is needed. */
async function startRemoveTeam(
  interaction: ButtonInteraction,
  scrim: ScrimLite,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);

  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await replyError(interaction, "No slot available to remove.");
    return;
  }

  const context: PickContext = { kind: "remove_team", scrimId: scrim.id };

  await showPick(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${numText(slot.num)}`.slice(0, 100),
      value: slot.id,
      description: truncate(slot.teamName ?? "—", 40),
      emoji: "📇",
    })),
    context,
    {
      placeholder: "Select the slot to remove...",
      question: "Kindly choose a slot from the dropdown.",
      ephemeral: true,
    },
  );
}

/** "Punish": pick the slots, then the ban type, then write the reason. */
async function startPunish(
  interaction: ButtonInteraction,
  scrim: ScrimLite,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);

  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await replyError(interaction, "No slot in the scrim to ban.");
    return;
  }

  const context: PickContext = { kind: "punish_slots", scrimId: scrim.id };

  await showPick(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: truncate(slot.teamName ?? "—", 40),
      emoji: "📇",
    })),
    context,
    {
      placeholder: "Select the slots to ban the teams...",
      question: "Kindly choose slots from the dropdown.",
      maxValues: Math.min(claimed.length, 25),
      ephemeral: true,
    },
  );
}

/** "Info": pick the slot, then show who is in it. */
async function startInfo(
  interaction: ButtonInteraction,
  scrim: ScrimLite,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);

  if (slots.length === 0) {
    await replyError(interaction, "No slot in the scrim to fetch info.");
    return;
  }

  const context: PickContext = { kind: "info", scrimId: scrim.id };

  await showPick(
    interaction,
    slots.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: truncate(slot.teamName ?? "—", 40),
      emoji: "📇",
    })),
    context,
    {
      placeholder: "Select the slot to get info...",
      question: "Kindly choose slots from the dropdown.",
      ephemeral: true,
    },
  );
}

/** The slot number as text. */
function numText(num: number): string {
  return String(num);
}

/* ------------------------------------------------------------------ *
 * The pick handlers
 * ------------------------------------------------------------------ */

/** "Add Team": the slot was picked, the form opens. */
export async function handleAddTeamPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "add_team") return;

  const num = Number(values[0]);

  if (!Number.isInteger(num)) {
    await replyError(interaction, "That slot is no longer available.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const token = issueModalToken({
    kind: "add_team",
    scrimId: context.scrimId,
    num,
  });

  await interaction.showModal(
    buildModal({
      customId: slotsId("modal_team", token),
      title: "Add a team to the slotlist",
      texts: [
        {
          id: "team_name",
          label: "Team Name",
          placeholder: "Enter the team name...",
          required: true,
          minLength: 3,
          maxLength: 25,
        },
        {
          id: "leader",
          label: "Team leader (mention, optional)",
          placeholder: "Mention the captain of that team",
          required: false,
          maxLength: 100,
        },
      ],
    }),
  );
}

/** "Change Team": the slot was picked, the form opens. */
export async function handleChangeTeamPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "change_team") return;

  const slotId = values[0];

  if (!slotId) {
    await replyError(interaction, "That slot no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const token = issueModalToken({
    kind: "change_team",
    scrimId: context.scrimId,
    slotId,
  });

  await interaction.showModal(
    buildModal({
      customId: slotsId("modal_team", token),
      title: "Change the team of a slot",
      texts: [
        {
          id: "team_name",
          label: "Team Name",
          placeholder: "Enter the team name...",
          required: true,
          minLength: 3,
          maxLength: 25,
        },
        {
          id: "leader",
          label: "Team leader (mention, optional)",
          placeholder: "Mention the captain of that team",
          required: false,
          maxLength: 100,
        },
      ],
    }),
  );
}

/** "Remove Team": the slot was picked, it is freed. */
export async function handleRemoveTeamPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "remove_team") return;

  const slotId = values[0];

  if (!slotId) {
    await replyError(interaction, "That slot no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const result = await service.removeTeam(repo.slotStore, { slotId });

  if (!result.ok) {
    await replyError(interaction, "That slot no longer exists.");
    return;
  }

  if (result.roleRemoved && result.ownerId) {
    await removeScrimRole(
      interaction.guild,
      result.slot.scrimId,
      result.ownerId,
    );
  }

  await afterSlotChange(interaction.client, result.slot.scrimId);

  await replySuccess(interaction, "Team removed from the slotlist.");
}

/** "Info": the slot was picked, its details are shown. */
export async function handleInfoPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "info") return;

  const slotId = values[0];

  if (!slotId) {
    await replyError(interaction, "That slot no longer exists.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const slot = await repo.getSlot(slotId);

  if (!slot) {
    await replyError(interaction, "That slot no longer exists.");
    return;
  }

  if (!slot.ownerUserId || slot.ownerUserId === service.MODERATOR_OWNER_ID) {
    await respond(
      interaction,
      {
        content:
          "**This slot was manually added by a Scrims Moderator.**\n\n`No other info present.`",
      },
      true,
    );

    return;
  }

  const lines = [
    `**Slot No:** \`${slot.num}\``,
    `**Name:** \`${slot.teamName ?? "—"}\``,
    `**Captain:** <@${slot.ownerUserId}>`,
    `**Team:** ${slot.members.map((id) => `<@${id}>`).join(", ") || "`None`"}`,
  ];

  if (slot.jumpUrl) {
    lines.push(`**Registration Message:** [Click me to Jump](${slot.jumpUrl})`);
  }

  await respond(interaction, { content: lines.join("\n") }, true);
}

/** "Punish": the slots were picked, the ban type is chosen next. */
export async function handlePunishSlotsPick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "punish_slots") return;

  if (values.length === 0) {
    await replyError(interaction, "No slot was selected.", { ephemeral: true });
    return;
  }

  clearPickMenu(interaction);

  const modeContext: PickContext = {
    kind: "punish_mode",
    scrimId: context.scrimId,
    slotIds: [...values],
  };

  await showPick(
    interaction,
    BAN_MODES.map((mode) => ({
      label: BAN_MODE_LABELS[mode].slice(0, 100),
      value: String(mode),
      emoji: "🔨",
    })),
    modeContext,
    {
      placeholder: "Choose the style of the ban",
      question: "Ban karne ka style choose karo :)",
      ephemeral: true,
    },
  );
}

/** "Punish": the ban type was chosen, the reason form opens. */
export async function handlePunishModePick(params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}): Promise<void> {
  const { interaction, values, context } = params;

  if (context.kind !== "punish_mode") return;

  const mode = Number(values[0]) as BanMode;

  if (!BAN_MODES.includes(mode)) {
    await replyError(interaction, "That ban type is not available.", {
      ephemeral: true,
    });

    return;
  }

  clearPickMenu(interaction);

  const token = issueModalToken({
    kind: "punish",
    scrimId: context.scrimId,
    slotIds: [...context.slotIds],
    mode,
  });

  await interaction.showModal(
    buildModal({
      customId: slotsId("modal_punish", token),
      title: "Ban time and reason",
      texts: [
        {
          id: "duration",
          label: "Ban duration (optional)",
          placeholder: "7 days, 24h, Friday at 6pm",
          required: false,
          maxLength: 64,
        },
        {
          id: "reason",
          label: "Reason (optional)",
          placeholder: "Why are they banned?",
          required: false,
          maxLength: 200,
        },
      ],
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The ban
 * ------------------------------------------------------------------ */

/** What a punish needs to know. */
export interface PunishParams {
  readonly scrimId: string;
  readonly slotIds: readonly string[];
  readonly mode: BanMode;
  readonly reason: string | null;
  readonly expires: Date | null;
  /**
   * The moderator.
   *
   * It goes into the ban log, so the log says who did it. `null` when
   * the bot did it.
   */
  readonly moderatorId: string | null;
  /** The guild, for the ban log. `null` when there is none to write to. */
  readonly guild: Guild | null;
}

/**
 * Bans the teams of the chosen slots.
 *
 * The four modes are real behaviour and all four are kept. The plan is
 * worked out first, so the message can say exactly what happened.
 *
 * **The ban log is written here.** The slot area owns the published slot
 * list, so it owns the Punish button on it, and a ban made through that
 * button has to leave the same trail a ban made anywhere else leaves.
 * The write never fails the ban: the rows are already in the database
 * and a moderator's ban has to stand.
 */
export async function punishSlots(params: PunishParams): Promise<string> {
  const scrim = await repo.getScrim(params.scrimId);

  if (!scrim) return "This scrim no longer exists.";

  const allScrimIds = await repo.listScrimIds(scrim.guildId);

  const entries: { scrimId: string; userId: string }[] = [];

  for (const slotId of params.slotIds) {
    const slot = await repo.getSlot(slotId);

    if (!slot) continue;

    const plan = service.planBan({
      mode: params.mode,
      thisScrimId: scrim.id,
      allScrimIds,
      leaderId: slot.ownerUserId,
      memberIds: slot.members,
    });

    for (const scrimId of plan.scrimIds) {
      for (const userId of plan.userIds) {
        entries.push({ scrimId, userId });
      }
    }
  }

  const unique = new Map<string, { scrimId: string; userId: string }>();

  for (const entry of entries) {
    unique.set(`${entry.scrimId}:${entry.userId}`, entry);
  }

  const list = [...unique.values()];

  await repo.banUsers(list, params.reason, params.expires);

  if (params.expires) {
    const scrimIds = [...new Set(list.map((entry) => entry.scrimId))];
    const userIds = [...new Set(list.map((entry) => entry.userId))];

    await repo
      .scheduleBanExpiry(scrimIds, userIds, params.expires)
      .catch((error: unknown) => {
        logger.error("[Slots] Could not arm the ban expiry job:", error);
      });
  }

  await logBans(list, {
    guild: params.guild,
    moderatorId: params.moderatorId,
    reason: params.reason,
    expires: params.expires,
    fallbackScrimName: scrim.name,
  });

  return `Banned ${plural(list.length, "player")} from ${plural(
    new Set(list.map((entry) => entry.scrimId)).size,
    "scrim",
  )}.`;
}

/** What an unban needs to know. */
export interface UnbanParams {
  /** The scrims the members are banned from. */
  readonly scrimIds: readonly string[];
  /** The members to unban. */
  readonly userIds: readonly string[];
  /** The moderator. It goes into the ban log. */
  readonly moderatorId: string | null;
  /** The guild, for the ban log. `null` when there is none to write to. */
  readonly guild: Guild | null;
}

/**
 * Lifts the bans, and writes the trail.
 *
 * The unban is the same shape as the ban log's other half: one entry
 * per unban, saying who was unbanned, from which scrim, and what the
 * ban had been. **The write never fails the unban** — the ban row is
 * already gone by the time the log is written, and a ban that is lifted
 * but not logged is a hole in the audit trail, not a refused unban.
 */
export async function unbanSlots(params: UnbanParams): Promise<string> {
  const entries = await service.unbanUsers(repo.slotStore, {
    scrimIds: params.scrimIds,
    userIds: params.userIds,
  });

  await logUnbans(entries, {
    guild: params.guild,
    moderatorId: params.moderatorId,
  });

  if (entries.length === 0) return "Nobody was unbanned.";

  return `Unbanned ${plural(entries.length, "player")} from ${plural(
    new Set(entries.map((entry) => entry.scrimId)).size,
    "scrim",
  )}.`;
}

/* ------------------------------------------------------------------ *
 * The ban log
 * ------------------------------------------------------------------ */

/** What the log write needs to know. */
interface BanLogContext {
  readonly guild: Guild | null;
  readonly moderatorId: string | null;
  readonly reason?: string | null;
  readonly expires?: Date | null;
  /** The name to use when a scrim cannot be read. */
  readonly fallbackScrimName?: string;
}

/**
 * Writes the ban log entries of a punish.
 *
 * **One entry per ban.** A ban is a (scrim, member) pair, and the log
 * says who was banned, from what and why, so every pair gets its own
 * entry. A mode that bans a team from every scrim of the server
 * therefore leaves one entry per pair — the same count the scrims
 * area's own unban and expiry paths leave.
 */
async function logBans(
  bans: readonly { readonly scrimId: string; readonly userId: string }[],
  context: BanLogContext,
): Promise<void> {
  if (bans.length === 0) return;

  const guild = context.guild;

  // Nowhere to write: the ban still stands, and there is no log to
  // write it to.
  if (!guild) return;

  try {
    const names = await scrimNames(
      bans.map((ban) => ban.scrimId),
      context.fallbackScrimName ?? "a scrim",
    );

    await writeBanLogs(
      guild,
      bans.map((ban) => ({
        action: "banned" as const,
        userId: ban.userId,
        scrimName: names.get(ban.scrimId) ?? "a scrim",
        reason: context.reason ?? null,
        expires: context.expires ?? null,
        moderatorId: context.moderatorId,
      })),
    );
  } catch (error: unknown) {
    // The log is a nuisance; the ban is not. It stands.
    logger.warn("[Slots] Could not write the ban log of the ban:", error);
  }
}

/**
 * Writes the ban log entries of an unban.
 *
 * One entry per unban, the way one entry is written per ban.
 */
async function logUnbans(
  unbans: readonly service.UnbanEntry[],
  context: BanLogContext,
): Promise<void> {
  if (unbans.length === 0) return;

  const guild = context.guild;

  // Nowhere to write: the ban is still lifted.
  if (!guild) return;

  try {
    const names = await scrimNames(
      unbans.map((unban) => unban.scrimId),
      context.fallbackScrimName ?? "a scrim",
    );

    await writeBanLogs(
      guild,
      unbans.map((unban) => ({
        action: "unbanned" as const,
        userId: unban.userId,
        scrimName: names.get(unban.scrimId) ?? "a scrim",
        reason: unban.reason,
        expires: unban.expires,
        moderatorId: context.moderatorId,
      })),
    );
  } catch (error: unknown) {
    // The ban is already lifted; the log is a hole in the trail, not a
    // refused unban.
    logger.warn("[Slots] Could not write the ban log of the unban:", error);
  }
}

/**
 * The name of every scrim of a batch, read one by one.
 *
 * A punish may span every scrim of the server, and the ban log says
 * which scrim each ban was from, so the names are needed. They are read
 * once each and remembered.
 */
async function scrimNames(
  scrimIds: readonly string[],
  fallback: string,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  for (const scrimId of scrimIds) {
    if (names.has(scrimId)) continue;

    const scrim = await repo.getScrim(scrimId);

    names.set(scrimId, scrim?.name ?? fallback);
  }

  return names;
}

/**
 * Refreshes the panel and the slot list after a moderator's change.
 */
export async function afterSlotChange(
  client: Client,
  scrimId: string,
): Promise<void> {
  await refreshScrimSlotlist(client, scrimId);

  const manager = await repo.findSlotManagerForScrim(scrimId);

  if (!manager) return;

  await refreshPublicMessage(client, manager.id);
}

/** Gives the scrim's role to a member. */
export async function grantRole(
  guild: ButtonInteraction["guild"],
  scrimId: string,
  userId: string,
): Promise<void> {
  await addScrimRole(guild, scrimId, userId);
}

/** Takes the scrim's role away from a member. */
export async function revokeRole(
  guild: ButtonInteraction["guild"],
  scrimId: string,
  userId: string,
): Promise<void> {
  await removeScrimRole(guild, scrimId, userId);
}
