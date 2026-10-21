/**
 * The setup wizard.
 *
 * The source's wizard was a view with nine buttons that each opened a
 * `bot.wait_for("message")` collector (`inputs.string_input`,
 * `inputs.channel_input`, `inputs.role_input`). That is the class of
 * flow D17 bans: somebody else typing in the channel, the bot's own
 * messages, timeouts, races with the bot's own handler.
 *
 * Ours uses a **modal** for a value and a **select menu** for a channel
 * or a role. The state of a wizard that has not been saved has no
 * database row, so it lives in a **token** (D18) — a random id into an
 * in-memory map with a time to live.
 *
 * The wizard's fields: registration channel, confirm channel, success
 * role, required mentions, total slots, teams per group, the two
 * reaction emojis, the days the tournament opens on and the time it
 * opens at.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { OPEN_DAYS } from "../schedule.js";
import type { TourneyEmojis } from "../types.js";
import {
  assertComponentBudget,
  button,
  buttonRow,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel } from "./handlers.js";

/** How long a wizard draft lives. */
const WIZARD_TTL_MS = 30 * 60_000;

/** The state the wizard collects. */
export interface WizardDraft {
  readonly guildId: string;
  readonly hostId: string;
  readonly name: string;
  readonly registrationChannelId: string | null;
  readonly confirmChannelId: string | null;
  readonly roleId: string | null;
  readonly requiredMentions: number;
  readonly totalSlots: number | null;
  readonly groupSize: number | null;
  readonly emojis: TourneyEmojis;
  /** The weekdays the tournament opens on. Empty means every day. */
  readonly openDays: string[];
  /** The time of day it opens at, in the server's zone. */
  readonly openTime: string;
}

/** The drafts of the wizards that are running. */
export const wizardStore = new TokenStore<WizardDraft>({
  ttlMs: WIZARD_TTL_MS,
});

/** The default draft for a guild. */
export function newDraft(guildId: string, hostId: string): WizardDraft {
  return {
    guildId,
    hostId,
    name: "Tournament",
    registrationChannelId: null,
    confirmChannelId: null,
    roleId: null,
    requiredMentions: 4,
    totalSlots: null,
    groupSize: null,
    emojis: { tick: "✅", cross: "❌" },
    openDays: [],
    openTime: "18:00",
  };
}

/** The fields of the wizard, in the order they are shown. */
export interface WizardField {
  readonly key: string;
  readonly label: string;
  /** How the field is collected. */
  readonly kind: "channel" | "role" | "number" | "emojis" | "text" | "days";
}

/** The wizard's fields, in the order they are shown. */
export const WIZARD_FIELDS: readonly WizardField[] = [
  { key: "set_reg_channel", label: "Registration Channel", kind: "channel" },
  { key: "set_confirm_channel", label: "Confirm Channel", kind: "channel" },
  { key: "set_role", label: "Success Role", kind: "role" },
  { key: "set_mentions", label: "Mentions", kind: "number" },
  { key: "set_slots", label: "Total Slots", kind: "number" },
  { key: "set_group_size", label: "Teams per Group", kind: "number" },
  { key: "set_emojis", label: "Reactions", kind: "emojis" },
  { key: "set_open_days", label: "Open Days", kind: "days" },
  { key: "set_open_time", label: "Open Time", kind: "text" },
];

/**
 * The wizard panel.
 *
 * @param token the token the draft is behind. It travels in every
 *              custom id, so the wizard survives a restart of the
 *              *message* (not of the process — a draft has no row).
 */
export function buildWizardPanel(draft: WizardDraft, token: string): Panel {
  const embed = new EmbedBuilder()
    .setTitle("Tournament setup")
    .setColor(EMBED_COLOR)
    .setDescription(
      "Fill the fields below and press **Save**. The tournament starts as a draft — press **Start Reg** afterwards to open the registration.",
    );

  embed.addFields(
    { name: "Name", value: `\`${draft.name}\``, inline: true },
    {
      name: "Registration Channel",
      value: draft.registrationChannelId
        ? `<#${draft.registrationChannelId}>`
        : "`Not set`",
      inline: true,
    },
    {
      name: "Confirm Channel",
      value: draft.confirmChannelId
        ? `<#${draft.confirmChannelId}>`
        : "`Not set`",
      inline: true,
    },
    {
      name: "Success Role",
      value: draft.roleId ? `<@&${draft.roleId}>` : "`Not set`",
      inline: true,
    },
    {
      name: "Required Mentions",
      value: `\`${draft.requiredMentions}\``,
      inline: true,
    },
    {
      name: "Total Slots",
      value: draft.totalSlots ? `\`${draft.totalSlots}\`` : "`Not set`",
      inline: true,
    },
    {
      name: "Teams per Group",
      value: draft.groupSize ? `\`${draft.groupSize}\`` : "`Not set`",
      inline: true,
    },
    {
      name: "Reactions",
      value: `${draft.emojis.tick},${draft.emojis.cross}`,
      inline: true,
    },
    {
      name: "Open Days",
      value:
        draft.openDays.length > 0
          ? draft.openDays.map((day) => `\`${day}\``).join(", ")
          : "`Every day`",
      inline: true,
    },
    {
      name: "Open Time",
      value: `\`${draft.openTime}\``,
      inline: true,
    },
  );

  const ready =
    draft.registrationChannelId !== null &&
    draft.confirmChannelId !== null &&
    draft.roleId !== null &&
    draft.totalSlots !== null;

  const rows: Panel["components"] = [];

  const first = WIZARD_FIELDS.slice(0, 5);
  const second = WIZARD_FIELDS.slice(5);

  rows.push(
    buttonRow(
      ...first.map((field, index) =>
        button({
          customId: tourneysId("wizard", field.key, token),
          label: `${String.fromCharCode(97 + index)} ${field.label}`,
          style: ButtonStyle.Secondary,
        }),
      ),
    ),
  );

  rows.push(
    buttonRow(
      ...second.map((field, index) =>
        button({
          customId: tourneysId("wizard", field.key, token),
          label: `${String.fromCharCode(97 + 5 + index)} ${field.label}`,
          style: ButtonStyle.Secondary,
        }),
      ),
      button({
        customId: tourneysId("wizard", "save", token),
        label: "Save",
        style: ButtonStyle.Success,
        disabled: !ready,
      }),
      button({
        customId: tourneysId("wizard", "cancel", token),
        label: "Cancel",
        style: ButtonStyle.Danger,
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * The days a tournament may open on, as a comma-separated list.
 *
 * The wizard and the editor collect them as text, because a multi-select
 * menu would take a row of the panel's component budget and the panel
 * already needs every row.
 */
export function formatOpenDays(days: readonly string[]): string {
  if (days.length === 0) return "every day";

  return days.join(", ");
}

/**
 * Parses a comma-separated list of weekday names.
 *
 * @returns the names that are weekdays, lower-cased and de-duplicated.
 */
export function parseOpenDays(input: string): string[] {
  const known = new Set<string>(OPEN_DAYS);

  const seen = new Set<string>();

  for (const part of input.split(",")) {
    const day = part.trim().toLowerCase();

    if (!known.has(day)) continue;

    seen.add(day);
  }

  return OPEN_DAYS.filter((day) => seen.has(day));
}
