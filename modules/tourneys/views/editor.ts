/**
 * The tournament editor.
 *
 * The source's editor was a view with eighteen buttons that each opened
 * a message collector, and — the important part — **rebuilt the whole
 * model from `dict(self.record)` on every interaction**:
 *
 * ```python
 * _d = dict(self.record)
 * del _d["id"]
 * del _d["banned_users"]
 * await Tourney.filter(pk=self.record.pk).update(**_d)
 * ```
 *
 * That wrote every column, including the ones another writer may have
 * changed in the meantime, and it relied on Tortoise's internals to
 * decide which of them were columns at all. Ours writes **one field** —
 * the one the button touched (D44, B18).
 *
 * The custom id carries the field *and* the tournament's id, so a
 * moderator can open the editor, set three fields over an hour, and come
 * back to it.
 *
 * **The editor is a table of settings.** The twenty fields are peers,
 * so their buttons are the twenty letters and they are all grey — a
 * table has no "most likely" field. The embed lists the fields in the
 * same order with the same letters, and the destructive button is red
 * and sits in the last row, next to the grey way back.
 */

import {
  actionRow,
  assertComponentBudget,
  dangerButton,
  panelEmbed,
  secondaryButton,
} from "../../../core/ui.js";
import type { TourneyRecord, TourneySchedule } from "../types.js";
import { EDITOR_FIELDS, fieldLetter } from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/**
 * The editor panel.
 *
 * @param tourney  the tournament being edited;
 * @param schedule the tournament's open schedule, when it has one.
 */
export function buildEditorPanel(
  tourney: TourneyRecord,
  schedule: TourneySchedule | null,
): Panel {
  const values: Record<string, string> = {
    set_name: `\`${tourney.name}\``,
    set_reg_channel: `<#${tourney.registrationChannelId}>`,
    set_confirm_channel: `<#${tourney.confirmChannelId}>`,
    set_role: `<@&${tourney.roleId}>`,
    set_mentions: `\`${tourney.requiredMentions}\``,
    set_slots: `\`${tourney.totalSlots}\``,
    set_group_size: `\`${tourney.groupSize ?? "not set"}\``,
    set_emojis: `${tourney.emojis.tick},${tourney.emojis.cross}`,
    set_ping_role: tourney.pingRoleId ? `<@&${tourney.pingRoleId}>` : "`Not set`",
    set_open_role: tourney.openRoleId ? `<@&${tourney.openRoleId}>` : "`Not set`",
    toggle_multireg: tourney.multiregister ? "`Allowed`" : "`Not allowed`",
    toggle_teamname: tourney.teamnameCompulsion ? "`Yes`" : "`No`",
    toggle_dup_name: tourney.noDuplicateName ? "`Not allowed`" : "`Allowed`",
    toggle_del_reject: tourney.autodeleteRejects ? "`Yes`" : "`No`",
    set_lines: `\`${tourney.requiredLines}\``,
    toggle_dup_tags: tourney.allowDuplicateTags ? "`Allowed`" : "`Not allowed`",
    set_start_from: `\`${tourney.startFrom}\``,
    set_open_days:
      schedule && schedule.openDays.length > 0
        ? schedule.openDays.map((day) => `\`${day}\``).join(", ")
        : "`Every day`",
    set_open_time: `\`${schedule?.openTime ?? "18:00"}\``,
    set_success_message: tourney.successMessage ? "`Set`" : "`Not set`",
  };

  const embed = panelEmbed({
    title: `Edit tournament — ${tourney.name}`,
    description: `\`${tourney.id}\``,
    fields: EDITOR_FIELDS.map((field, index) => ({
      name: `${fieldLetter(index).toUpperCase()} · ${field.label}`,
      value: values[field.key] ?? "`—`",
      inline: true,
    })),
    footer: "Press a letter to change that field. One press changes one field.",
  });

  const rows: PanelComponents = [];

  // The field buttons, in rows of five. A premium field keeps its
  // diamond: a mark that carries a meaning on its own.
  const buttons = EDITOR_FIELDS.map((field, index) =>
    secondaryButton({
      customId: tourneysId("editor", field.key, tourney.id),
      label: fieldLetter(index).toUpperCase(),
      emoji: field.premium ? "💎" : undefined,
    }),
  );

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(actionRow(...buttons.slice(index, index + 5)));
  }

  // The last row: the destructive button, and the way back.
  rows.push(
    actionRow(
      dangerButton({
        customId: tourneysId("editor", "delete", tourney.id),
        label: "Delete tournament",
      }),
      secondaryButton({
        customId: tourneysId("manager", tourney.id),
        label: "Back",
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
