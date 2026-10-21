/**
 * The group-management UI.
 *
 * Three pieces, all carried by the custom ids:
 *
 *  - the **manager**, which creates the channels and the roles and
 *    publishes a group list;
 *  - the **publish panel**, which picks the group and the channel and
 *    posts the list;
 *  - the **published list**, which carries a persistent refresh button.
 *
 * The refresh button's custom id carries the **row id** of the published
 * list (D18), so the button keeps working after a restart and finds the
 * channel by id rather than by a name substring (B15).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import { makeCustomId } from "../../../core/custom-id.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../../core/constants.js";
import { respond } from "../../../core/context.js";
import { errorMessage } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import * as groups from "../groups.js";
import type { GroupSlot } from "../types.js";

/* ------------------------------------------------------------------ *
 * Custom ids
 * ------------------------------------------------------------------ */

/** The prefix of every id of this feature. */
export const GROUPS_PREFIX = "identity:groups";

/** The actions the feature understands. */
export const GROUP_ACTIONS = {
  /** Open the manager. */
  manager: "manager",
  /** Create the channels and the roles. */
  create: "create",
  /** Open the publish panel. */
  publish: "publish",
  /** Refresh a published list. */
  refresh: "refresh",
  /** Show the teams of a published list. */
  info: "info",
  /** Pick the group. */
  selectGroup: "select_group",
  /** Pick the channel. */
  selectChannel: "select_channel",
  /** Publish the list. */
  send: "send",
  /** Close the publish panel. */
  cancel: "cancel",
} as const;

/** One of the feature's actions. */
export type GroupAction = (typeof GROUP_ACTIONS)[keyof typeof GROUP_ACTIONS];

/**
 * Builds a custom id.
 */
export function groupCustomId(action: GroupAction, target?: string): string {
  const payload = target === undefined ? action : `${action}:${target}`;

  return makeCustomId("identity", "groups", payload);
}

/**
 * Splits a payload back into its action and its target.
 */
export function parseGroupPayload(
  payload: string | null,
): { action: string; target: string | null } {
  if (!payload) return { action: "", target: null };

  const separator = payload.indexOf(":");

  if (separator === -1) return { action: payload, target: null };

  return {
    action: payload.slice(0, separator),
    target: payload.slice(separator + 1),
  };
}

/* ------------------------------------------------------------------ *
 * The publish panel's state
 * ------------------------------------------------------------------ */

/** What the publish panel is holding. */
export interface PublishDraft {
  readonly tourneyId: string;
  groupNumber: number | null;
  channelId: string | null;
}

/** The drafts of the publish panels that are open. */
const drafts = new TokenStore<PublishDraft>();

/**
 * Opens a publish panel.
 *
 * @returns the token that goes into the custom ids.
 */
export function startPublishPanel(draft: PublishDraft): string {
  return drafts.issue({ ...draft });
}

/**
 * Reads a draft.
 */
export function readPublishDraft(token: string): PublishDraft | undefined {
  return drafts.get(token);
}

/**
 * Writes a draft back.
 */
export function writePublishDraft(token: string, draft: PublishDraft): void {
  drafts.issue({ ...draft });
}

/**
 * Throws a draft away.
 */
export function dropPublishDraft(token: string): void {
  drafts.delete(token);
}

/**
 * Stops the draft store's sweep timer.
 */
export function stopPublishPanelStore(): void {
  drafts.stop();
}

/* ------------------------------------------------------------------ *
 * The panels
 * ------------------------------------------------------------------ */

/**
 * Builds the group manager.
 *
 * The tourney area calls this from its own panel: the group manager is a
 * part of the tournament, but the code that creates and publishes the
 * groups lives here.
 */
export function buildGroupManagerPanel(input: {
  tourneyId: string;
  tourneyName: string;
}): { embed: EmbedBuilder; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Tourney Group Management — ${input.tourneyName}`)
    .setDescription(
      [
        "Use **Create Channels & Roles** to set up the tourney groups.",
        "Use **Publish group list** to post a group's slot list in a channel.",
      ].join("\n"),
    );

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(groupCustomId(GROUP_ACTIONS.create, input.tourneyId))
      .setLabel("Create Channels & Roles")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(groupCustomId(GROUP_ACTIONS.publish, input.tourneyId))
      .setLabel("Publish group list")
      .setStyle(ButtonStyle.Success),
  );

  return { embed, components: [row] };
}

/**
 * Builds the panel that publishes a group list.
 */
export function buildPublishPanel(
  token: string,
  draft: PublishDraft,
  groupNumbers: readonly number[],
): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Publish a group list")
    .addFields(
      {
        name: "Group",
        value: draft.groupNumber ? `\`${draft.groupNumber}\`` : "`Not-Set`",
        inline: true,
      },
      {
        name: "Channel",
        value: draft.channelId ? `<#${draft.channelId}>` : "`Not-Set`",
        inline: true,
      },
    );

  const groupRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.selectGroup, token))
        .setPlaceholder("The group to publish")
        .setMaxValues(1)
        .addOptions(
          groupNumbers.map((number) => ({
            label: `Group ${number}`,
            value: String(number),
          })),
        ),
    );

  const channelRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.selectChannel, token))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMaxValues(1)
        .setPlaceholder("The channel to publish it in"),
    );

  const buttonRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.send, token))
        .setLabel("Publish")
        .setStyle(ButtonStyle.Success)
        .setDisabled(draft.groupNumber === null || draft.channelId === null),
      new ButtonBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.cancel, token))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

  return { embed, components: [groupRow, channelRow, buttonRow] };
}

/**
 * The custom id of the modal that asks for the format and the range.
 */
export function createChannelsModalId(tourneyId: string): string {
  return groupCustomId(GROUP_ACTIONS.create, tourneyId);
}

/**
 * Builds the modal that asks for the name format and the range.
 */
export function buildCreateChannelsModal(tourneyId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(createChannelsModalId(tourneyId))
    .setTitle("Create the group channels and roles")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("format")
          .setLabel("Name format")
          .setPlaceholder("For example: Group {0}")
          .setMaxLength(groups.MAX_GROUP_FORMAT_LENGTH)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("range")
          .setLabel("Range")
          .setPlaceholder("For example: 1-5")
          .setMaxLength(16)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

/**
 * Builds the embed of a published group list.
 */
export function buildGroupListEmbed(input: {
  tourneyName: string;
  groupNumber: number;
  slots: readonly GroupSlot[];
  startFrom: number;
}): EmbedBuilder {
  const body = input.slots
    .map((slot, index) => `Slot ${String(index + input.startFrom).padStart(2, "0")}  ->  ${slot.teamName}`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${input.tourneyName} - Group ${input.groupNumber}`)
    .setDescription(`\`\`\`\n${body}\n\`\`\``);
}

/**
 * Builds the components of a published group list.
 *
 * The refresh button is **persistent**: it stays on the message until the
 * message is deleted.
 */
export function buildGroupListComponents(entryId: string): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.refresh, entryId))
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(groupCustomId(GROUP_ACTIONS.info, entryId))
        .setLabel("Info")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

/**
 * Answers a button.
 */
export async function handleGroupButton(
  interaction: ButtonInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseGroupPayload(payload);

  try {
    switch (action) {
      case GROUP_ACTIONS.create:
        return await openCreateModal(interaction, target);
      case GROUP_ACTIONS.publish:
        return await openPublishPanel(interaction, target);
      case GROUP_ACTIONS.send:
        return await publishGroupList(interaction, target);
      case GROUP_ACTIONS.cancel:
        return await closePublishPanel(interaction, target);
      case GROUP_ACTIONS.refresh:
        return await refreshPublishedList(interaction, target);
      case GROUP_ACTIONS.info:
        return await showPublishedListInfo(interaction, target);
      default:
        logger.debug(`[Identity] Unknown group action "${action}".`);

        return undefined;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);
  }
}

/**
 * Answers a select menu.
 */
export async function handleGroupSelect(
  interaction: AnySelectMenuInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseGroupPayload(payload);

  if (!target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const draft = readPublishDraft(target);

  if (!draft) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  if (action === GROUP_ACTIONS.selectGroup) {
    const value = interaction.values[0];

    if (value) draft.groupNumber = Number.parseInt(value, 10);
  } else if (action === GROUP_ACTIONS.selectChannel) {
    const value = interaction.values[0];

    if (value) draft.channelId = value;
  } else {
    logger.debug(`[Identity] Unknown group select action "${action}".`);

    return;
  }

  writePublishDraft(target, draft);

  const tourney = await groups.findTourney(draft.tourneyId);

  if (!tourney) {
    await respond(interaction, { content: "That tourney no longer exists." }, true);

    return;
  }

  const groupSize = tourney.groupSize ?? 0;

  const groupNumbers = await buildGroupNumbers(draft.tourneyId, groupSize);

  const panel = buildPublishPanel(target, draft, groupNumbers);

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}

/**
 * Answers the modal that asks for the format and the range.
 */
export async function handleGroupModal(
  interaction: ModalSubmitInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseGroupPayload(payload);

  if (action !== GROUP_ACTIONS.create || !target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const format = interaction.fields.getTextInputValue("format").trim();
  const range = interaction.fields.getTextInputValue("range").trim();

  const parsed = parseGroupRange(range);

  const problem = groups.validateGroupFormat(format, parsed.from, parsed.to);

  if (problem) {
    await respond(interaction, { content: problem }, true);

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await respond(interaction, { content: "This only works in a server." }, true);

    return;
  }

  const tourney = await groups.findTourney(target);

  // The role that may manage the group channels is the tournament's own
  // role, by id. Quotient looked a `tourney-mod` role up by name (D16).
  const modRoleId = tourney?.roleId ?? null;

  try {
    const plan = await groups.createGroupChannels(
      guild,
      { format, from: parsed.from, to: parsed.to },
      modRoleId,
    );

    await respond(
      interaction,
      {
        content:
          `✅ Created ${plan.channelIds.length} group channels and ${plan.roleIds.length} roles.`,
      },
      true,
    );
  } catch (error) {
    await respond(
      interaction,
      {
        content: `❌ The creation failed and everything it had made was removed again.\n${errorMessage(error)}`,
      },
      true,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The handlers, one by one
 * ------------------------------------------------------------------ */

async function openCreateModal(
  interaction: ButtonInteraction,
  tourneyId: string | null,
): Promise<void> {
  if (!tourneyId) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  await interaction.showModal(buildCreateChannelsModal(tourneyId));
}

async function openPublishPanel(
  interaction: ButtonInteraction,
  tourneyId: string | null,
): Promise<void> {
  if (!tourneyId) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const tourney = await groups.findTourney(tourneyId);

  if (!tourney) {
    await respond(
      interaction,
      { content: "That tourney no longer exists." },
      true,
    );

    return;
  }

  if (!tourney.groupSize) {
    await respond(
      interaction,
      {
        content:
          "**The group size is not set.** Set the number of teams per group before publishing a group list.",
      },
      true,
    );

    return;
  }

  const groupNumbers = await buildGroupNumbers(tourneyId, tourney.groupSize);

  if (groupNumbers.length === 0) {
    await respond(
      interaction,
      { content: "Nobody has registered yet." },
      true,
    );

    return;
  }

  const token = startPublishPanel({
    tourneyId,
    groupNumber: null,
    channelId: null,
  });

  const panel = buildPublishPanel(
    token,
    {
      tourneyId,
      groupNumber: null,
      channelId: null,
    },
    groupNumbers,
  );

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}

async function publishGroupList(
  interaction: ButtonInteraction,
  token: string | null,
): Promise<void> {
  if (!token) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const draft = readPublishDraft(token);

  if (!draft || draft.groupNumber === null || draft.channelId === null) {
    await respond(
      interaction,
      { content: "Pick a group and a channel first." },
      true,
    );

    return;
  }

  const tourney = await groups.findTourney(draft.tourneyId);

  if (!tourney || !tourney.groupSize) {
    await respond(interaction, { content: "That tourney no longer exists." }, true);

    return;
  }

  const slots = await groups.getGroup(
    draft.tourneyId,
    tourney.groupSize,
    draft.groupNumber,
  );

  if (slots.length === 0) {
    await respond(interaction, { content: "That group has no teams." }, true);

    return;
  }

  const channel = interaction.guild?.channels.cache.get(draft.channelId);

  if (!channel || !("send" in channel)) {
    await respond(
      interaction,
      { content: "I cannot post in that channel." },
      true,
    );

    return;
  }

  const embed = buildGroupListEmbed({
    tourneyName: tourney.name,
    groupNumber: draft.groupNumber,
    slots,
    startFrom: 1,
  });

  const message = await channel.send({
    content: "",
    embeds: [embed],
    components: [],
  });

  // The row is written **after** the message, so the row's id can go into
  // the message's components.
  const entryId = await groups.recordGroupList({
    tourneyId: draft.tourneyId,
    messageId: message.id,
    channelId: draft.channelId,
    groupNumber: draft.groupNumber,
  });

  await message.edit({
    embeds: [embed],
    components: buildGroupListComponents(entryId),
  });

  dropPublishDraft(token);

  await respond(interaction, { content: "✅ The group list is published." }, true);
}

async function closePublishPanel(
  interaction: ButtonInteraction,
  token: string | null,
): Promise<void> {
  if (token) dropPublishDraft(token);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription("This panel is closed."),
    ],
    components: [],
  });
}

async function refreshPublishedList(
  interaction: ButtonInteraction,
  entryId: string | null,
): Promise<void> {
  if (!entryId) {
    await respond(interaction, { content: "This button has expired." }, true);

    return;
  }

  const entry = await groups.findGroupList(entryId);

  if (!entry) {
    await respond(
      interaction,
      { content: "That group list no longer exists." },
      true,
    );

    return;
  }

  if (!groups.canRefreshGroupList(entry)) {
    const wait = Math.ceil(groups.groupListRefreshWait(entry) / 1000);

    await respond(
      interaction,
      { content: `You can only refresh every 2 minutes. Try again in ${wait} seconds.` },
      true,
    );

    return;
  }

  const tourney = await groups.findTourney(entry.tourneyId);

  if (!tourney || !tourney.groupSize) {
    await respond(
      interaction,
      { content: "That tourney no longer exists." },
      true,
    );

    return;
  }

  const slots = await groups.getGroup(
    entry.tourneyId,
    tourney.groupSize,
    entry.groupNumber,
  );

  const embed = buildGroupListEmbed({
    tourneyName: tourney.name,
    groupNumber: entry.groupNumber,
    slots,
    startFrom: 1,
  });

  // The row's `updated_at` is written **only** here, so it is the time of
  // the last refresh and nothing else.
  await groups.touchGroupList(entry.id);

  await interaction.update({
    embeds: [embed],
    components: buildGroupListComponents(entry.id),
  });

  await respond(
    interaction,
    { content: "✅ The group list was refreshed." },
    true,
  );
}

async function showPublishedListInfo(
  interaction: ButtonInteraction,
  entryId: string | null,
): Promise<void> {
  if (!entryId) {
    await respond(interaction, { content: "This button has expired." }, true);

    return;
  }

  const entry = await groups.findGroupList(entryId);

  if (!entry) {
    await respond(
      interaction,
      { content: "That group list no longer exists." },
      true,
    );

    return;
  }

  const tourney = await groups.findTourney(entry.tourneyId);

  if (!tourney || !tourney.groupSize) {
    await respond(
      interaction,
      { content: "That tourney no longer exists." },
      true,
    );

    return;
  }

  const slots = await groups.getGroup(
    entry.tourneyId,
    tourney.groupSize,
    entry.groupNumber,
  );

  const lines = slots.map((slot) => `**${slot.teamName}** — <@${slot.leaderId}>`);

  await respond(
    interaction,
    {
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle(`Group ${entry.groupNumber}`)
          .setDescription(lines.join("\n") || "This group has no teams."),
      ],
    },
    true,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The group numbers a tourney has.
 */
async function buildGroupNumbers(
  tourneyId: string,
  groupSize: number,
): Promise<number[]> {
  const count = await groups.countGroups(tourneyId, groupSize);

  return Array.from({ length: count }, (_unused, index) => index + 1);
}

/**
 * Parses a range like `1-5`.
 */
export function parseGroupRange(range: string): { from: number; to: number } {
  const parts = range.split("-");

  const from = Number.parseInt(parts[0] ?? "", 10);
  const to = Number.parseInt(parts[1] ?? "", 10);

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { from: 0, to: 0 };
  }

  return { from, to };
}
