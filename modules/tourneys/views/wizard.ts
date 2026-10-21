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
 * **The wizard is a step-by-step flow, and the panel says so.** The
 * steps are the letters, the embed shows what every step holds right
 * now, and the step that is next — the first one that is not filled in
 * yet — is the panel's primary button and is named in the description.
 * **Cancel** is the way back: it is grey, because a draft that has not
 * been saved is not a record and nothing is destroyed by throwing it
 * away. **Save tournament** is green, because saving is what creates
 * the tournament.
 *
 * The wizard's fields: registration channel, confirm channel, success
 * role, required mentions, total slots, teams per group, the two
 * reaction emojis, the days the tournament opens on and the time it
 * opens at.
 */

import { TokenStore } from "../../../core/custom-id.js";
import {
  actionRow,
  assertComponentBudget,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";
import { OPEN_DAYS } from "../schedule.js";
import type { WizardDraft } from "../types.js";
import { fieldLetter } from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/** How long a wizard draft lives. */
const WIZARD_TTL_MS = 30 * 60_000;

/** The drafts of the wizards that are running. */
export const wizardStore = new TokenStore<WizardDraft>({
  ttlMs: WIZARD_TTL_MS,
});

export type { WizardDraft };

/** The fields of the wizard, in the order they are shown. */
export interface WizardField {
  readonly key: string;
  readonly label: string;
  /** How the field is collected. */
  readonly kind: "channel" | "role" | "number" | "emojis" | "text" | "days";
}

/**
 * The wizard's fields, in the order they are shown.
 *
 * The order is the order of the steps, and the panel numbers them the
 * same way, so the button and the embed field always agree.
 */
export const WIZARD_FIELDS: readonly WizardField[] = [
  { key: "set_reg_channel", label: "Registration channel", kind: "channel" },
  { key: "set_confirm_channel", label: "Confirm channel", kind: "channel" },
  { key: "set_role", label: "Success role", kind: "role" },
  { key: "set_mentions", label: "Required mentions", kind: "number" },
  { key: "set_slots", label: "Total slots", kind: "number" },
  { key: "set_group_size", label: "Teams per group", kind: "number" },
  { key: "set_emojis", label: "Reactions", kind: "emojis" },
  { key: "set_open_days", label: "Open days", kind: "days" },
  { key: "set_open_time", label: "Open time", kind: "text" },
];

/** One step of the wizard. */
interface WizardStep {
  readonly field: WizardField;
  /** The letter the step's button carries. */
  readonly letter: string;
}

/**
 * The wizard panel.
 *
 * @param token the token the draft is behind. It travels in every
 *              custom id, so the wizard survives a restart of the
 *              *message* (not of the process — a draft has no row).
 */
export function buildWizardPanel(draft: WizardDraft, token: string): Panel {
  const steps: WizardStep[] = WIZARD_FIELDS.map((field, index) => ({
    field,
    letter: fieldLetter(index).toUpperCase(),
  }));

  const next = steps.find((step) => !isFilled(draft, step.field.key)) ?? null;

  const ready =
    draft.registrationChannelId !== null &&
    draft.confirmChannelId !== null &&
    draft.roleId !== null &&
    draft.totalSlots !== null;

  const embed = panelEmbed({
    title: "Create a tournament",
    description: next
      ? `Next step: **${next.letter} · ${next.field.label}**`
      : "Every step is filled in. Save the tournament when you are ready.",
    fields: steps.map((step) => ({
      name: `${step.letter} · ${step.field.label}`,
      value: stepValue(draft, step.field.key),
      inline: true,
    })),
    footer:
      "Press a letter to fill that step in. The tournament is created as a draft — the registration opens afterwards.",
  });

  const rows: PanelComponents = [];

  // The steps, in rows of five. The step that is next is the primary:
  // it is the thing to do now.
  const buttons = steps.map((step) =>
    step === next
      ? primaryButton({
          customId: tourneysId("wizard", step.field.key, token),
          label: step.letter,
        })
      : secondaryButton({
          customId: tourneysId("wizard", step.field.key, token),
          label: step.letter,
        }),
  );

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(actionRow(...buttons.slice(index, index + 5)));
  }

  // The main action: saving is what creates the tournament.
  rows.push(
    actionRow(
      successButton({
        customId: tourneysId("wizard", "save", token),
        label: "Save tournament",
        disabled: !ready,
      }),
    ),
  );

  // The way out. A wizard that can only be saved is a trap.
  rows.push(
    navigationRow(
      secondaryButton({
        customId: tourneysId("wizard", "cancel", token),
        label: "Cancel",
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * Is the step's value already set?
 *
 * The steps that start with a default — the mentions, the reactions,
 * the open days and the open time — count as filled in, because there
 * is nothing to decide about them.
 */
function isFilled(draft: WizardDraft, key: string): boolean {
  switch (key) {
    case "set_reg_channel":
      return draft.registrationChannelId !== null;
    case "set_confirm_channel":
      return draft.confirmChannelId !== null;
    case "set_role":
      return draft.roleId !== null;
    case "set_slots":
      return draft.totalSlots !== null;
    case "set_group_size":
      return draft.groupSize !== null;
    default:
      return true;
  }
}

/** A step's value, as the embed shows it. */
function stepValue(draft: WizardDraft, key: string): string {
  switch (key) {
    case "set_reg_channel":
      return draft.registrationChannelId
        ? `<#${draft.registrationChannelId}>`
        : "`Not set`";
    case "set_confirm_channel":
      return draft.confirmChannelId ? `<#${draft.confirmChannelId}>` : "`Not set`";
    case "set_role":
      return draft.roleId ? `<@&${draft.roleId}>` : "`Not set`";
    case "set_mentions":
      return `\`${draft.requiredMentions}\``;
    case "set_slots":
      return draft.totalSlots ? `\`${draft.totalSlots}\`` : "`Not set`";
    case "set_group_size":
      return draft.groupSize ? `\`${draft.groupSize}\`` : "`Not set`";
    case "set_emojis":
      return `${draft.emojis.tick},${draft.emojis.cross}`;
    case "set_open_days":
      return draft.openDays.length > 0
        ? draft.openDays.map((day) => `\`${day}\``).join(", ")
        : "`Every day`";
    case "set_open_time":
      return `\`${draft.openTime}\``;
    default:
      return "`Not set`";
  }
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
