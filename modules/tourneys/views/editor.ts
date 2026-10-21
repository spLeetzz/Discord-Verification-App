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
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import type { TourneyRecord, TourneySchedule } from "../types.js";
import {
  EDITOR_FIELDS,
  assertComponentBudget,
  button,
  buttonRow,
  fieldLetter,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel } from "./handlers.js";

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
  const embed = new EmbedBuilder()
    .setTitle(`Tournament Editor — ${tourney.name}`)
    .setColor(EMBED_COLOR)
    .setDescription("Choose a field below to change it. One press changes one field.");

  embed.addFields(
    { name: "Name", value: `\`${tourney.name}\``, inline: true },
    {
      name: "Registration Channel",
      value: `<#${tourney.registrationChannelId}>`,
      inline: true,
    },
    {
      name: "Confirm Channel",
      value: `<#${tourney.confirmChannelId}>`,
      inline: true,
    },
    { name: "Success Role", value: `<@&${tourney.roleId}>`, inline: true },
    {
      name: "Mentions",
      value: `\`${tourney.requiredMentions}\``,
      inline: true,
    },
    {
      name: "Slots",
      value: `\`${tourney.totalSlots}\``,
      inline: true,
    },
    {
      name: "Teams per Group",
      value: `\`${tourney.groupSize ?? "not set"}\``,
      inline: true,
    },
    {
      name: "Reactions",
      value: `${tourney.emojis.tick},${tourney.emojis.cross}`,
      inline: true,
    },
    {
      name: "Ping Role",
      value: tourney.pingRoleId ? `<@&${tourney.pingRoleId}>` : "`Not set`",
      inline: true,
    },
    {
      name: "Open Role",
      value: tourney.openRoleId ? `<@&${tourney.openRoleId}>` : "`Not set`",
      inline: true,
    },
    {
      name: "Multi-Register",
      value: tourney.multiregister ? "`Allowed`" : "`Not allowed!`",
      inline: true,
    },
    {
      name: "Team-Name Compulsion",
      value: tourney.teamnameCompulsion ? "`Yes!`" : "`No!`",
      inline: true,
    },
    {
      name: "Duplicate Team Name",
      value: tourney.noDuplicateName ? "`Not allowed!`" : "`Allowed`",
      inline: true,
    },
    {
      name: "Autodelete Rejected",
      value: tourney.autodeleteRejects ? "`Yes!`" : "`No!`",
      inline: true,
    },
    {
      name: "Required Lines",
      value: `\`${tourney.requiredLines}\``,
      inline: true,
    },
    {
      name: "Duplicate / Fake Tags",
      value: tourney.allowDuplicateTags ? "`Allowed`" : "`Not allowed!`",
      inline: true,
    },
    {
      name: "Slotlist Start From",
      value: `\`${tourney.startFrom}\``,
      inline: true,
    },
    {
      name: "Open Days",
      value:
        schedule && schedule.openDays.length > 0
          ? schedule.openDays.map((day) => `\`${day}\``).join(", ")
          : "`Every day`",
      inline: true,
    },
    {
      name: "Open Time",
      value: `\`${schedule?.openTime ?? "18:00"}\``,
      inline: true,
    },
    {
      name: "Success Message",
      value: tourney.successMessage ? "`Set`" : "`Not set`",
      inline: true,
    },
  );

  const buttons = EDITOR_FIELDS.map((field, index) =>
    button({
      customId: tourneysId("editor", field.key, tourney.id),
      label: `${fieldLetter(index)} ${field.label}`,
      emoji: field.premium ? "💎" : undefined,
      style: field.kind === "toggle" ? ButtonStyle.Secondary : ButtonStyle.Primary,
    }),
  );

  const rows: Panel["components"] = [];

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(buttonRow(...buttons.slice(index, index + 5)));
  }

  rows.push(
    buttonRow(
      button({
        customId: tourneysId("manager", tourney.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: tourneysId("editor", "delete", tourney.id),
        label: "Delete Tournament",
        style: ButtonStyle.Danger,
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
