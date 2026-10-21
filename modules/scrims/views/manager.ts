/**
 * The management panels: the list, one scrim, the editor and the wizard.
 *
 * Every panel is a **render of the database row**. A button writes one
 * field and the message is re-rendered from the row that comes back, so
 * a panel that is opened after a restart shows the truth rather than
 * whatever the process happened to have in memory.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { InteractionReplyOptions } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { discordTimestamp, formatTimestamp } from "../../../core/time.js";
import { TokenStore } from "../../../core/custom-id.js";
import { Day } from "../../../core/constants.js";
import type { AutocleanKind, Weekday } from "../../../db/schema/common.js";
import {
  EDITOR_FIELDS,
  assertComponentBudget,
  button,
  buttonRow,
  fieldLetter,
} from "./components.js";
import { scrimsId } from "./ids.js";
import { formatDuration } from "../render.js";
import type { ScrimRecord } from "../types.js";

/** The components of a panel. */
export type PanelComponents = NonNullable<
  InteractionReplyOptions["components"]
>;

/* ------------------------------------------------------------------ *
 * The list panel
 * ------------------------------------------------------------------ */

/**
 * The panel that lists the scrims of a guild.
 *
 * The select menu carries the scrim ids as its values, so choosing one
 * is enough to move to that scrim's panel — no state, and it survives a
 * restart.
 */
export function buildListPanel(
  scrims: readonly ScrimRecord[],
  canCreate: boolean,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle("Scrims Manager")
    .setColor(EMBED_COLOR);

  if (scrims.length === 0) {
    embed.setDescription("No scrims yet. Press **Create Scrim** to make one.");
  } else {
    embed.setDescription(
      scrims
        .map(
          (scrim, index) =>
            `\`${String(index + 1).padStart(2, "0")}.\` ${scrim.enabled ? "✅" : "❌"} **${scrim.name}** — ${discordTimestamp(scrim.openTime, "t")}\n\`${scrim.id}\``,
        )
        .join("\n"),
    );

    embed.setFooter({
      text: `Total scrims in this server: ${scrims.length}`,
    });
  }

  const rows: PanelComponents = [];

  if (scrims.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(scrimsId("pick"))
      .setPlaceholder("Pick a scrim to manage")
      .setMinValues(1)
      .setMaxValues(1);

    for (const scrim of scrims.slice(0, 25)) {
      menu.addOptions({
        label: scrim.name.slice(0, 100),
        value: scrim.id,
        description: scrim.id.slice(0, 100),
      });
    }

    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    );
  }

  rows.push(
    buttonRow(
      button({
        customId: scrimsId("new"),
        label: "Create Scrim",
        style: ButtonStyle.Success,
        disabled: !canCreate,
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * One scrim
 * ------------------------------------------------------------------ */

/** The panel of one scrim: the actions a moderator can take on it. */
export function buildScrimPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Scrims Manager — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        `**Status:** \`${scrim.status}\``,
        `**Enabled:** ${scrim.enabled ? "✅" : "❌"}`,
        `**Registration:** <#${scrim.registrationChannelId}>`,
        `**Slotlist:** <#${scrim.slotlistChannelId}>`,
        `**Success Role:** ${scrim.roleId ? `<@&${scrim.roleId}>` : "`Not set`"}`,
        `**Slots:** \`${scrim.totalSlots}\` (from \`${scrim.startFrom}\`)`,
        `**Open Time:** ${discordTimestamp(scrim.openTime, "f")}`,
        `**Open Days:** ${scrim.openDays.map((day) => day.slice(0, 2)).join(", ")}`,
        `**Autoclean:** ${scrim.autoclean.join(", ") || "`Off`"}`,
        `**Time taken:** ${formatDuration(scrim.timeElapsedSeconds)}`,
      ].join("\n"),
    );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("editor", scrim.id),
        label: "Edit Settings",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: scrimsId("manager", scrim.id, "toggle"),
        label: scrim.status === "open" ? "Stop Reg" : "Start Reg",
        style:
          scrim.status === "open" ? ButtonStyle.Danger : ButtonStyle.Success,
      }),
      button({
        customId: scrimsId("reserve", scrim.id),
        label: "Reserve Slots",
        style: ButtonStyle.Success,
      }),
      button({
        customId: scrimsId("ban", scrim.id),
        label: "Ban / Unban",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("design", scrim.id),
        label: "Design",
        style: ButtonStyle.Secondary,
      }),
    ),
    buttonRow(
      button({
        customId: scrimsId("slotlist", scrim.id),
        label: "Manage Slotlist",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: scrimsId("manager", scrim.id, "match_time"),
        label: "Set Match Time",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("manager", scrim.id, "enabled"),
        label: scrim.enabled ? "Disable" : "Enable",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("manager", scrim.id, "delete"),
        label: "Delete",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("list"),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

/**
 * The twenty-field editor.
 *
 * Five rows of five: twenty fields, then Prev / Skip to / Next / Delete
 * / Main Menu. That is exactly 25 components, which is Discord's limit
 * for one message, so the layout is counted by
 * {@link assertComponentBudget} rather than by eye.
 *
 * **"Skip to" is implemented, not a dead button.** The source's callback
 * only deferred and did nothing. Ours opens a modal that takes the
 * scrim's number in the list, and moves the editor to it.
 */
export function buildEditorPanel(
  scrim: ScrimRecord,
  position: { readonly index: number; readonly total: number },
  canDelete: boolean,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle("Scrims Editor — Edit Settings")
    .setColor(EMBED_COLOR);

  const values: Record<string, string> = {
    set_name: `\`${scrim.name}\``,
    set_reg_channel: `<#${scrim.registrationChannelId}>`,
    set_slot_channel: `<#${scrim.slotlistChannelId}>`,
    set_role: scrim.roleId ? `<@&${scrim.roleId}>` : "`Not set`",
    set_mentions: `\`${scrim.requiredMentions}\``,
    set_slots: `\`${scrim.totalSlots}\``,
    set_open_time: `${discordTimestamp(scrim.openTime, "t")} (${formatTimestamp(scrim.openTime)})`,
    set_emojis: `${scrim.emojis.tick},${scrim.emojis.cross}`,
    set_ping_role: scrim.pingRoleId ? `<@&${scrim.pingRoleId}>` : "`Not set`",
    set_open_role: scrim.openRoleId ? `<@&${scrim.openRoleId}>` : "`Not set`",
    toggle_multireg: scrim.multiregister ? "`Allowed`" : "`Not allowed`",
    toggle_teamname: scrim.teamnameCompulsion ? "`Yes`" : "`No`",
    toggle_dup_name: scrim.noDuplicateName ? "`Not allowed`" : "`Allowed`",
    toggle_del_reject: scrim.autodeleteRejects ? "`Yes`" : "`No`",
    toggle_del_late: scrim.autodeleteExtras ? "`Yes`" : "`No`",
    set_start_from: `\`${scrim.startFrom}\``,
    set_autoclean: scrim.autocleanTime
      ? `${discordTimestamp(scrim.autocleanTime, "t")} (\`${scrim.autoclean.join(", ") || "nothing"}\`)`
      : "`Turned OFF`",
    set_days:
      scrim.openDays.length > 0
        ? scrim.openDays.map((day) => `\`${day.slice(0, 2)}\``).join(", ")
        : "`Not set`",
    set_lines: scrim.requiredLines > 0 ? `\`${scrim.requiredLines}\`` : "`Not set`",
    toggle_dup_tags: scrim.allowDuplicateTags
      ? "`Allowed`"
      : "`Not allowed`",
  };

  for (const [index, field] of EDITOR_FIELDS.entries()) {
    embed.addFields({
      name: `${fieldLetter(index)} ${field.label}:`,
      value: values[field.key] ?? "`—`",
      inline: true,
    });
  }

  embed.setFooter({
    text: `Scrim ${position.index + 1} of ${position.total} — ${scrim.id}`,
  });

  const rows: PanelComponents = [];

  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const buttons: ButtonBuilder[] = [];

    for (let column = 0; column < 5; column += 1) {
      const fieldIndex = rowIndex * 5 + column;
      const field = EDITOR_FIELDS[fieldIndex];

      if (!field) continue;

      buttons.push(
        button({
          customId: scrimsId("editor", field.key, scrim.id),
          label: fieldLetter(fieldIndex).toUpperCase(),
          emoji: "📝",
          style: ButtonStyle.Secondary,
        }),
      );
    }

    rows.push(buttonRow(...buttons));
  }

  rows.push(
    buttonRow(
      button({
        customId: scrimsId("editor_nav", "prev", scrim.id),
        label: "Previous",
        style: ButtonStyle.Secondary,
        disabled: position.total < 2,
      }),
      button({
        customId: scrimsId("editor_nav", "skip", scrim.id),
        label: "Skip to…",
        style: ButtonStyle.Secondary,
        disabled: position.total < 2,
      }),
      button({
        customId: scrimsId("editor_nav", "next", scrim.id),
        label: "Next",
        style: ButtonStyle.Secondary,
        disabled: position.total < 2,
      }),
      button({
        customId: scrimsId("manager", scrim.id, "delete"),
        label: "Delete",
        style: ButtonStyle.Danger,
        disabled: !canDelete,
      }),
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * The wizard
 * ------------------------------------------------------------------ */

/** What the wizard collects before the scrim exists. */
export interface WizardState {
  readonly guildId: string;
  readonly hostId: string;
  name: string;
  registrationChannelId: string | null;
  slotlistChannelId: string | null;
  roleId: string | null;
  requiredMentions: number;
  totalSlots: number | null;
  openTime: Date | null;
  openDays: Weekday[];
  emojis: { tick: string; cross: string };
  startFrom: number;
  autoclean: AutocleanKind[];
  autocleanTime: Date | null;
}

/** The wizard's own store. Its entries expire after fifteen minutes. */
export const wizardStore = new TokenStore<WizardState>({
  ttlMs: 15 * 60_000,
});

/** A fresh wizard. */
export function newWizardState(
  guildId: string,
  hostId: string,
): WizardState {
  return {
    guildId,
    hostId,
    name: "Quotient-Scrims",
    registrationChannelId: null,
    slotlistChannelId: null,
    roleId: null,
    requiredMentions: 4,
    totalSlots: null,
    openTime: null,
    openDays: Object.values(Day),
    emojis: { tick: "✅", cross: "❌" },
    startFrom: 1,
    autoclean: ["channel", "role"],
    autocleanTime: null,
  };
}

/** Is the wizard complete enough to save? */
export function wizardIsComplete(state: WizardState): boolean {
  return Boolean(
    state.registrationChannelId &&
      state.slotlistChannelId &&
      state.roleId &&
      state.totalSlots &&
      state.totalSlots > 0 &&
      state.openTime,
  );
}

/**
 * The wizard panel.
 *
 * The wizard's state is a **token**, not a row: the scrim does not
 * exist yet, which is exactly the case D18 says a token is for.
 */
export function buildWizardPanel(
  state: WizardState,
  token: string,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle("Create a Scrim — enter the details, then press Save")
    .setColor(EMBED_COLOR);

  const fields: [string, string][] = [
    ["Reg. Channel", state.registrationChannelId ? `<#${state.registrationChannelId}>` : "`Not-Set`"],
    ["Slotlist Channel", state.slotlistChannelId ? `<#${state.slotlistChannelId}>` : "`Not-Set`"],
    ["Success Role", state.roleId ? `<@&${state.roleId}>` : "`Not-Set`"],
    ["Req. Mentions", `\`${state.requiredMentions}\``],
    ["Total Slots", state.totalSlots ? `\`${state.totalSlots}\`` : "`Not-Set`"],
    [
      "Open Time",
      state.openTime
        ? `${discordTimestamp(state.openTime, "t")} (${formatTimestamp(state.openTime)})`
        : "`Not-Set`",
    ],
    [
      "Scrim Days",
      state.openDays.map((day) => `\`${day.slice(0, 2)}\``).join(", ") || "`Not-Set`",
    ],
    ["Reactions", `${state.emojis.tick},${state.emojis.cross}`],
  ];

  for (const [index, [label, value]] of fields.entries()) {
    embed.addFields({
      name: `${fieldLetter(index)} ${label}:`,
      value,
      inline: true,
    });
  }

  embed.setFooter({ text: "The scrim is created when you press Save." });

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("wizard", "set_reg_channel", token),
        label: "A",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_slot_channel", token),
        label: "B",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_role", token),
        label: "C",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_mentions", token),
        label: "D",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_slots", token),
        label: "E",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
    ),
    buttonRow(
      button({
        customId: scrimsId("wizard", "set_open_time", token),
        label: "F",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_days", token),
        label: "G",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "set_emojis", token),
        label: "H",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("wizard", "cancel", token),
        label: "Cancel",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("wizard", "save", token),
        label: "Save Scrim",
        style: ButtonStyle.Success,
        disabled: !wizardIsComplete(state),
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
