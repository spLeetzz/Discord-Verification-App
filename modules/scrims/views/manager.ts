/**
 * The management panels: the list, one scrim, the editor and the wizard.
 *
 * Every panel is a **render of the database row**. A button writes one
 * field and the message is re-rendered from the row that comes back, so
 * a panel that is opened after a restart shows the truth rather than
 * whatever the process happened to have in memory.
 *
 * **The shape every panel here has.** One main action, alone on its own
 * row, coloured by what it does — green creates, red destroys, blurple
 * is a plain action. The other rows group the remaining actions by
 * meaning, and the last row is the way back, always grey.
 *
 * The embeds follow the same rule: a title, a short description, the
 * data as fields, and a footer that says what to do next — so the
 * description does not have to shout it.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { EmbedBuilder } from "discord.js";
import { discordTimestamp, formatTimestamp } from "../../../core/time.js";
import { plural } from "../../../core/text.js";
import { TokenStore } from "../../../core/custom-id.js";
import { Day } from "../../../core/constants.js";
import {
  actionRow,
  dangerButton,
  label,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";
import type { AutocleanKind, Weekday } from "../../../db/schema/common.js";
import {
  EDITOR_FIELDS,
  assertComponentBudget,
  emptyScrimsPanel,
  fieldLetter,
} from "./components.js";
import { scrimsId } from "./ids.js";
import { formatDuration } from "../render.js";
import type { ScrimRecord } from "../types.js";

/**
 * The components of a panel.
 *
 * A panel is a list of rows; every row is either a row of buttons or a
 * row that holds one select menu.
 */
export type PanelComponents = (
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>
)[];

/* ------------------------------------------------------------------ *
 * The list panel
 * ------------------------------------------------------------------ */

/**
 * The dot that says what state a scrim is in.
 *
 * The dot is the state: a scrim that is open, a scrim that is waiting
 * and a scrim that is switched off look different at a glance, without
 * the eye having to read the word next to them.
 */
function scrimDot(scrim: ScrimRecord): string {
  if (!scrim.enabled) return "⚫";
  if (scrim.status === "open") return "🟢";

  return "🟡";
}

/** The word that goes with the dot. */
function scrimState(scrim: ScrimRecord): string {
  if (!scrim.enabled) return "disabled";
  if (scrim.status === "open") return "open";

  return "closed";
}

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
  if (scrims.length === 0) {
    // The first thing a new user sees. It says what a scrim is and what
    // to do, not only that the list is empty.
    const empty = emptyScrimsPanel({
      title: "Scrims Manager",
      description:
        "This server has no scrims yet. A scrim is a registration channel, a list of slots, and the slotlist that goes out when it closes.",
      footer: canCreate
        ? "Press **Create scrim** to make the first one."
        : "This server has reached the number of scrims its plan allows.",
      action: successButton({
        customId: scrimsId("new"),
        label: "Create scrim",
        disabled: !canCreate,
      }),
    });

    return { embeds: empty.embeds, components: empty.components };
  }

  const embed = panelEmbed({
    title: "Scrims Manager",
    description: scrims
      .map(
        (scrim) =>
          `${scrimDot(scrim)} **${scrim.name}** — ${scrimState(scrim)} · ${discordTimestamp(scrim.openTime, "t")}`,
      )
      .join("\n"),
    footer: `${plural(scrims.length, "scrim")} here — pick one from the menu to manage it.`,
  });

  const rows: PanelComponents = [];

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

  rows.push(
    actionRow(
      successButton({
        customId: scrimsId("new"),
        label: "Create scrim",
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
  const open = scrim.status === "open";

  const embed = panelEmbed({
    title: `Scrims Manager — ${scrim.name}`,
    description: !scrim.enabled
      ? "This scrim is disabled, so none of the setup below happens."
      : open
        ? "Registration is open."
        : "Registration is closed.",
    fields: [
      {
        name: "Registration",
        value: `<#${scrim.registrationChannelId}>`,
        inline: true,
      },
      {
        name: "Slotlist",
        value: `<#${scrim.slotlistChannelId}>`,
        inline: true,
      },
      {
        name: "Success role",
        value: scrim.roleId ? `<@&${scrim.roleId}>` : "Not set",
        inline: true,
      },
      {
        name: "Slots",
        value: `\`${scrim.totalSlots}\` (from \`${scrim.startFrom}\`)`,
        inline: true,
      },
      {
        name: "Opens",
        value: discordTimestamp(scrim.openTime, "f"),
        inline: true,
      },
      {
        name: "Open days",
        value:
          scrim.openDays.map((day) => label(day.slice(0, 2))).join(", ") ||
          "Not set",
        inline: true,
      },
      {
        name: "Autoclean",
        value: scrim.autoclean.join(", ") || "Off",
        inline: true,
      },
      {
        name: "Time taken",
        value: formatDuration(scrim.timeElapsedSeconds),
        inline: true,
      },
      { name: "Scrim id", value: `\`${scrim.id}\`` },
    ],
    footer: "Edit the settings here, or start the registration when you are ready.",
  });

  const rows: PanelComponents = [
    // The main action: the settings of the scrim live behind it.
    actionRow(
      primaryButton({
        customId: scrimsId("editor_open", scrim.id),
        label: "Edit settings",
      }),
    ),
    actionRow(
      open
        ? dangerButton({
            customId: scrimsId("manager", scrim.id, "toggle"),
            label: "Stop registration",
          })
        : successButton({
            customId: scrimsId("manager", scrim.id, "toggle"),
            label: "Start registration",
          }),
      secondaryButton({
        customId: scrimsId("reserve", scrim.id),
        label: "Reserve slots",
      }),
      secondaryButton({
        customId: scrimsId("ban", scrim.id),
        label: "Manage bans",
      }),
      secondaryButton({
        customId: scrimsId("design", scrim.id),
        label: "Design",
      }),
    ),
    actionRow(
      secondaryButton({
        customId: scrimsId("slotlist", scrim.id),
        label: "Manage slotlist",
      }),
      secondaryButton({
        customId: scrimsId("manager", scrim.id, "match_time"),
        label: "Set match time",
      }),
      secondaryButton({
        customId: scrimsId("manager", scrim.id, "enabled"),
        label: scrim.enabled ? "Disable scrim" : "Enable scrim",
      }),
      dangerButton({
        customId: scrimsId("manager", scrim.id, "delete"),
        label: "Delete scrim",
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("list"),
        label: "Back to list",
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
 * / Back. That is exactly 25 components, which is Discord's limit
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
        ? scrim.openDays.map((day) => `\`${label(day.slice(0, 2))}\``).join(", ")
        : "`Not set`",
    set_lines: scrim.requiredLines > 0 ? `\`${scrim.requiredLines}\`` : "`Not set`",
    toggle_dup_tags: scrim.allowDuplicateTags
      ? "`Allowed`"
      : "`Not allowed`",
  };

  const embed = panelEmbed({
    title: `Edit scrim — ${scrim.name}`,
    description: `\`${scrim.id}\``,
    fields: EDITOR_FIELDS.map((field, index) => ({
      name: `${fieldLetter(index).toUpperCase()} · ${field.label}`,
      value: values[field.key] ?? "`—`",
      inline: true,
    })),
    footer: `Scrim ${position.index + 1} of ${position.total} — press a letter to change that field.`,
  });

  const rows: PanelComponents = [];

  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const buttons: ButtonBuilder[] = [];

    for (let column = 0; column < 5; column += 1) {
      const fieldIndex = rowIndex * 5 + column;
      const field = EDITOR_FIELDS[fieldIndex];

      if (!field) continue;

      buttons.push(
        secondaryButton({
          customId: scrimsId("editor", field.key, scrim.id),
          label: fieldLetter(fieldIndex).toUpperCase(),
        }),
      );
    }

    rows.push(actionRow(...buttons));
  }

  // The last row carries the navigation and the delete. The editor uses
  // every one of the twenty-five components Discord allows, so there is
  // no room for a row of its own.
  rows.push(
    navigationRow(
      secondaryButton({
        customId: scrimsId("editor_nav", "prev", scrim.id),
        label: "Previous",
        disabled: position.total < 2,
      }),
      secondaryButton({
        customId: scrimsId("editor_nav", "skip", scrim.id),
        label: "Skip to",
        disabled: position.total < 2,
      }),
      secondaryButton({
        customId: scrimsId("editor_nav", "next", scrim.id),
        label: "Next",
        disabled: position.total < 2,
      }),
      dangerButton({
        customId: scrimsId("manager", scrim.id, "delete"),
        label: "Delete scrim",
        disabled: !canDelete,
      }),
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
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
  const fields: [string, string][] = [
    [
      "Registration channel",
      state.registrationChannelId
        ? `<#${state.registrationChannelId}>`
        : "`Not set`",
    ],
    [
      "Slotlist channel",
      state.slotlistChannelId ? `<#${state.slotlistChannelId}>` : "`Not set`",
    ],
    ["Success role", state.roleId ? `<@&${state.roleId}>` : "`Not set`"],
    ["Required mentions", `\`${state.requiredMentions}\``],
    ["Total slots", state.totalSlots ? `\`${state.totalSlots}\`` : "`Not set`"],
    [
      "Open time",
      state.openTime
        ? `${discordTimestamp(state.openTime, "t")} (${formatTimestamp(state.openTime)})`
        : "`Not set`",
    ],
    [
      "Scrim days",
      state.openDays.map((day) => `\`${label(day.slice(0, 2))}\``).join(", ") ||
        "`Not set`",
    ],
    ["Reactions", `${state.emojis.tick},${state.emojis.cross}`],
  ];

  const embed = panelEmbed({
    title: "Create a scrim",
    description:
      "A scrim is a registration channel, a list of slots, and the slotlist that goes out when it closes.",
    fields: fields.map(([name, value], index) => ({
      name: `${fieldLetter(index).toUpperCase()} · ${name}`,
      value,
      inline: true,
    })),
    footer: "The scrim is created when you press Save.",
  });

  const rows: PanelComponents = [
    actionRow(
      secondaryButton({
        customId: scrimsId("wizard", "set_reg_channel", token),
        label: "A",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_slot_channel", token),
        label: "B",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_role", token),
        label: "C",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_mentions", token),
        label: "D",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_slots", token),
        label: "E",
      }),
    ),
    actionRow(
      secondaryButton({
        customId: scrimsId("wizard", "set_open_time", token),
        label: "F",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_days", token),
        label: "G",
      }),
      secondaryButton({
        customId: scrimsId("wizard", "set_emojis", token),
        label: "H",
      }),
    ),
    // The main action: saving is what creates the scrim.
    actionRow(
      successButton({
        customId: scrimsId("wizard", "save", token),
        label: "Save scrim",
        disabled: !wizardIsComplete(state),
      }),
    ),
    // The way out. A wizard that can only be saved is a trap.
    navigationRow(
      secondaryButton({
        customId: scrimsId("wizard", "cancel", token),
        label: "Cancel",
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
