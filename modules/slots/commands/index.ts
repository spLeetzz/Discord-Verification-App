/**
 * The `/slotmanager` command.
 *
 * One top-level command with four subcommands:
 *
 *  - `setup` — create a slot manager: the channel, the public panel and
 *    the scrims it shows;
 *  - `edit` — open the editor of an existing slot manager;
 *  - `list` — what the server has;
 *  - `slotlist` — the published slot list: `show`, `punish` and `info`.
 *
 * The file in `commands/esports/slots.ts` is a one-line re-export of this.
 */

import {
  ChannelType,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../../../types/command.js";
import { awaitSelect } from "../../../core/select.js";
import { respond, replyError, replySuccess } from "../../../core/context.js";
import type { ReplyPayload } from "../../../core/context.js";
import { plural } from "../../../core/text.js";
import { emptyPanel, panelEmbed } from "../../../core/ui.js";
import type { PanelField } from "../../../core/ui.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { BAN_MODES, BAN_MODE_LABELS, BanMode } from "../types.js";
import {
  buildManagerEmbed,
  buildManagerRows,
  runSetup,
} from "../views/manager.js";
import { punishSlots, unbanSlots } from "../views/slotlist.js";
import { publishSlotList, refreshSlotListMessage } from "../slotlist.js";

/** A subcommand of `/slotmanager`. */
export interface SlotSubcommand {
  readonly data: SlashCommandSubcommandBuilder;
  run(interaction: ChatInputCommandInteraction): Promise<void>;
}

/** A group of subcommands of `/slotmanager`. */
export interface SlotSubcommandGroup {
  readonly data: SlashCommandSubcommandGroupBuilder;
  run(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * The ban durations the command's punish flow offers.
 *
 * A select menu of the durations, because a command interaction is
 * already deferred and Discord does not allow a modal after a defer —
 * so a command has no way to ask for a line of free text.
 */
export const BAN_DURATIONS: readonly {
  readonly label: string;
  readonly ms: number | null;
}[] = [
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "1 day", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000 },
  { label: "Forever", ms: null },
];

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

/** `/slotmanager setup` — create a slot manager. */
export const setupSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("setup")
    .setDescription("Create a slot-manager channel with its public panel."),

  async run(interaction) {
    await runSetup(interaction);
  },
};

/* ------------------------------------------------------------------ *
 * edit
 * ------------------------------------------------------------------ */

/** `/slotmanager edit` — open the editor of a slot manager. */
export const editSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("edit")
    .setDescription("Edit an existing slot-manager."),

  async run(interaction) {
    const guild = interaction.guild;

    if (!guild) {
      await replyError(interaction, "This only works in a server.");
      return;
    }

    const managers = await repo.listSlotManagers(guild.id);

    if (managers.length === 0) {
      await respond(interaction, emptySlotManagers());

      return;
    }

    const chosen = await awaitSelect(
      interaction,
      managers.map((manager) => ({
        label: `#${manager.mainChannelId}`.slice(0, 100),
        value: manager.id,
        description: `${manager.toggle ? "Enabled" : "Disabled"}`.slice(0, 100),
      })),
      {
        maxValues: 1,
        placeholder: "Select a slot-manager channel ...",
        question: "Kindly choose a slot-manager channel to edit.",
      },
    );

    const managerId = chosen[0];

    if (!managerId) return;

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
  },
};

/* ------------------------------------------------------------------ *
 * list
 * ------------------------------------------------------------------ */

/** `/slotmanager list` — what the server has. */
export const listSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("list")
    .setDescription("List the slot-managers of this server."),

  async run(interaction) {
    const guild = interaction.guild;

    if (!guild) {
      await replyError(interaction, "This only works in a server.");
      return;
    }

    const managers = await repo.listSlotManagers(guild.id);

    if (managers.length === 0) {
      await respond(interaction, emptySlotManagers());

      return;
    }

    const fields: PanelField[] = [];

    for (const manager of managers) {
      const scrimIds = await repo.listSlotManagerScrimIds(manager.id);

      fields.push({
        name: `<#${manager.mainChannelId}>`,
        value: `${plural(scrimIds.length, "scrim")} — ${manager.toggle ? "Enabled" : "Disabled"}`,
      });
    }

    const embed = panelEmbed({
      title: "Slot managers",
      description: "The slot-manager channels of this server.",
      fields,
      footer:
        "Run `/slotmanager edit` to change one of them, or `/slotmanager setup` to add another.",
    });

    await respond(interaction, { embeds: [embed] });
  },
};

/**
 * The empty state of the slot-manager commands.
 *
 * A server that has no slot manager yet is not in trouble, so this is
 * a plain panel and not a refusal — and it says what to do next.
 */
function emptySlotManagers(): ReplyPayload {
  const panel = emptyPanel({
    title: "No slot managers yet",
    description:
      "A slot manager is a channel where the members claim and cancel their own scrim slots.",
    footer: "Run `/slotmanager setup` to create one.",
  });

  return { embeds: [...panel.embeds], components: panel.components };
}

/* ------------------------------------------------------------------ *
 * slotlist
 * ------------------------------------------------------------------ */

/** `/slotmanager slotlist show` — publish the slot list of a scrim. */
export const slotListShowSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("show")
    .setDescription("Publish (or refresh) the slot list of a scrim."),

  async run(interaction) {
    const scrim = await pickScrim(interaction);

    if (!scrim) return;

    const guild = interaction.guild;

    if (!guild) {
      await replyError(interaction, "This only works in a server.");
      return;
    }

    const channel = guild.channels.cache.get(scrim.slotlistChannelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      await replyError(interaction, "I could not find the slotlist channel.");
      return;
    }

    // The message that is already published is re-rendered; a scrim
    // without one gets a new message. Both go through the area's
    // public API — the same one the scrims area uses when a scrim
    // closes — so the command and the lifecycle publish the same thing.
    const wasPublished = scrim.slotlistMessageId !== null;

    const messageId = await publishSlotList(scrim.id);

    if (!messageId) {
      await replyError(
        interaction,
        "There is nothing to publish yet — no team has registered a slot in this scrim.",
      );

      return;
    }

    await replySuccess(
      interaction,
      wasPublished
        ? "The slot list has been refreshed."
        : "The slot list has been published.",
    );
  },
};

/**
 * `/slotmanager slotlist punish` — ban the teams of a scrim's slots.
 *
 * **The reason is not asked for here.** A slash command is deferred by
 * the dispatcher before the command body runs, and Discord does not allow
 * a modal after a defer — so a command flow has no way to ask for a line
 * of free text. The slot list's **Punish** button has the full flow: a
 * select menu for the ban type and a modal for the reason and the
 * duration.
 */
export const slotListPunishSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("punish")
    .setDescription("Ban the teams of the chosen slots of a scrim."),

  async run(interaction) {
    const scrim = await pickScrim(interaction);

    if (!scrim) return;

    const slots = await repo.listSlots(scrim.id);

    const claimed = slots.filter((slot) => slot.state === "claimed");

    if (claimed.length === 0) {
      await replyError(interaction, "No slot in the scrim to ban.");
      return;
    }

    const chosen = await awaitSelect(
      interaction,
      claimed.slice(0, 25).map((slot) => ({
        label: `Slot ${slot.num}`.slice(0, 100),
        value: slot.id,
        description: (slot.teamName ?? "—").slice(0, 100),
      })),
      {
        maxValues: Math.min(claimed.length, 25),
        placeholder: "Select the slots to ban the teams...",
        question: "Kindly choose slots from the dropdown.",
      },
    );

    if (chosen.length === 0) return;

    const modes = await awaitSelect(
      interaction,
      BAN_MODES.map((mode) => ({
        label: BAN_MODE_LABELS[mode].slice(0, 100),
        value: String(mode),
        emoji: "🔨",
      })),
      {
        maxValues: 1,
        placeholder: "Choose the style of the ban",
        question: "Ban karne ka style choose karo :)",
      },
    );

    const mode = Number(modes[0]) as BanMode;

    if (!BAN_MODES.includes(mode)) {
      await replyError(interaction, "That ban type is not available.");
      return;
    }

    const durations = await awaitSelect(
      interaction,
      BAN_DURATIONS.map((entry) => ({
        label: entry.label.slice(0, 100),
        value: String(entry.ms ?? 0),
        emoji: "⏳",
      })),
      {
        maxValues: 1,
        placeholder: "How long is the ban?",
        question: "How long is the ban?",
      },
    );

    const chosenMs = Number(durations[0] ?? "0");
    const expires = chosenMs > 0 ? new Date(Date.now() + chosenMs) : null;

    const outcome = await punishSlots({
      scrimId: scrim.id,
      slotIds: chosen,
      mode,
      reason: null,
      expires,
      moderatorId: interaction.user.id,
      guild: interaction.guild,
    });

    // The published list is re-rendered, so the ban is visible on it.
    if (scrim.slotlistMessageId) {
      await refreshSlotListMessage(scrim.slotlistMessageId);
    }

    await replySuccess(interaction, outcome);
  },
};

/**
 * `/slotmanager slotlist unban` — lift the bans of a scrim.
 *
 * The published slot list is where a moderator bans a team, so this is
 * where they lift the ban again: the scrims area's ban panel is only
 * reachable from the messages it rendered before the handoff.
 *
 * **The reason is not asked for here.** A slash command is deferred by
 * the dispatcher before the command body runs, and Discord does not
 * allow a modal after a defer — so a command flow has no way to ask for
 * a line of free text. The ban log entry therefore carries the reason
 * the **ban** was given, which is read from the ban row.
 */
export const slotListUnbanSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("unban")
    .setDescription("Lift the bans of a scrim's slots."),

  async run(interaction) {
    const scrim = await pickScrim(interaction);

    if (!scrim) return;

    const bans = await repo.listBans(scrim.id);

    if (bans.length === 0) {
      await replyError(interaction, "Nobody is banned from this scrim.");
      return;
    }

    const chosen = await awaitSelect(
      interaction,
      bans.slice(0, 25).map((ban) => ({
        label: `<@${ban.userId}>`.slice(0, 100),
        value: ban.userId,
        description: ban.expires
          ? `Until ${ban.expires.toISOString().slice(0, 16).replace("T", " ")}`
          : "Never expires",
        emoji: "🔓",
      })),
      {
        maxValues: Math.min(bans.length, 25),
        placeholder: "Select the users to unban...",
        question: "Select the users to unban.",
      },
    );

    if (chosen.length === 0) return;

    const outcome = await unbanSlots({
      scrimIds: [scrim.id],
      userIds: chosen,
      moderatorId: interaction.user.id,
      guild: interaction.guild,
    });

    await replySuccess(interaction, outcome);
  },
};

/** `/slotmanager slotlist info` — who is in a slot. */
export const slotListInfoSubcommand: SlotSubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("info")
    .setDescription("Show who is in a slot of a scrim."),

  async run(interaction) {
    const scrim = await pickScrim(interaction);

    if (!scrim) return;

    const slots = await repo.listSlots(scrim.id);

    if (slots.length === 0) {
      await replyError(interaction, "No slot in the scrim to fetch info.");
      return;
    }

    const chosen = await awaitSelect(
      interaction,
      slots.slice(0, 25).map((slot) => ({
        label: `Slot ${slot.num}`.slice(0, 100),
        value: slot.id,
        description: (slot.teamName ?? "—").slice(0, 100),
      })),
      {
        maxValues: 1,
        placeholder: "Select the slot to get info...",
        question: "Kindly choose a slot from the dropdown.",
      },
    );

    const slotId = chosen[0];

    if (!slotId) return;

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
  },
};

/** The `/slotmanager slotlist` group. */
export const slotListGroup: SlotSubcommandGroup = {
  data: new SlashCommandSubcommandGroupBuilder()
    .setName("slotlist")
    .setDescription("The published slot list of a scrim.")
    .addSubcommand(slotListShowSubcommand.data)
    .addSubcommand(slotListPunishSubcommand.data)
    .addSubcommand(slotListUnbanSubcommand.data)
    .addSubcommand(slotListInfoSubcommand.data),

  async run(interaction) {
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === "show") {
      await slotListShowSubcommand.run(interaction);
      return;
    }

    if (subcommand === "punish") {
      await slotListPunishSubcommand.run(interaction);
      return;
    }

    if (subcommand === "unban") {
      await slotListUnbanSubcommand.run(interaction);
      return;
    }

    if (subcommand === "info") {
      await slotListInfoSubcommand.run(interaction);
      return;
    }

    await replyError(interaction, "That subcommand is not available.");
  },
};

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

/** The command group. */
export const slotManagerCommand: Command = {
  staffOnly: true,
  /**
   * D43: the esports commands are public by default, matching Quotient.
   * The dispatcher has to honour this flag; today it defers every
   * command ephemerally.
   */
  ephemeral: false,
  data: new SlashCommandBuilder()
    .setName("slotmanager")
    .setDescription("Manage the scrims slot manager.")
    .addSubcommand(setupSubcommand.data)
    .addSubcommand(editSubcommand.data)
    .addSubcommand(listSubcommand.data)
    .addSubcommandGroup(slotListGroup.data),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === "setup") {
      await setupSubcommand.run(interaction);
      return;
    }

    if (subcommand === "edit") {
      await editSubcommand.run(interaction);
      return;
    }

    if (subcommand === "list") {
      await listSubcommand.run(interaction);
      return;
    }

    if (subcommand === "slotlist") {
      await slotListGroup.run(interaction);
      return;
    }

    await interaction.editReply({
      content: "That subcommand is no longer available. Please try again.",
    });
  },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Asks the moderator to pick a scrim.
 *
 * @returns the scrim, or `null` when the moderator picked nothing.
 */
async function pickScrim(
  interaction: ChatInputCommandInteraction,
): Promise<Awaited<ReturnType<typeof repo.getScrim>>> {
  const guild = interaction.guild;

  if (!guild) {
    await replyError(interaction, "This only works in a server.");
    return null;
  }

  const scrims = await repo.listScrims(guild.id);

  if (scrims.length === 0) {
    await replyError(interaction, "This server has no scrims yet.");
    return null;
  }

  const chosen = await awaitSelect(
    interaction,
    scrims.slice(0, 25).map((scrim) => ({
      label: `#${scrim.name}`.slice(0, 100),
      value: scrim.id,
      description: scrim.registrationChannelId.slice(0, 100),
    })),
    {
      maxValues: 1,
      placeholder: "Select a scrim ...",
      question: "Choose the scrim.",
    },
  );

  const scrimId = chosen[0];

  if (!scrimId) return null;

  return repo.getScrim(scrimId);
}

export default slotManagerCommand;
