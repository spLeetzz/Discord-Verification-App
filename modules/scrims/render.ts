/**
 * Rendering the three scrim messages.
 *
 * D32: the templates are `jsonb` holding a typed {@link EmbedTemplate},
 * and one function renders them. The source stored a Python literal
 * string and re-parsed it with `ast.literal_eval` on every render, so
 * any template written by another code path crashed the next render.
 *
 * The `<<keyword>>` sets are ported as-is:
 *
 *  - open: `<<mentions>>` `<<slots>>` `<<reserved>>` `<<slotlist>>`
 *    `<<multireg>>` `<<teamname>>` (plus the source's two mention lists);
 *  - close: `<<slots>>` `<<filled>>` `<<time_taken>>` `<<open_time>>`;
 *  - slotlist: `<<name>>` `<<time_taken>>` `<<open_time>>` `<<slots>>`.
 */

import { EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../core/constants.js";
import { discordTimestamp } from "../../core/time.js";
import { plural } from "../../core/text.js";
import { applyKeywords, isEmptyTemplate } from "./template.js";
import type { EmbedTemplate, KeywordValues } from "./template.js";
import type { ScrimRecord, SlotRecord } from "./types.js";

/**
 * The default open message.
 *
 * The source built this when the stored template was empty.
 */
export function defaultOpenMessage(): EmbedTemplate {
  return {
    color: EMBED_COLOR,
    title: "Registration is now open!",
    description:
      "📣 **`<<mentions>>`** mentions required.\n📣 Total slots: **`<<slots>>`** [`<<reserved>>` slots reserved]",
  };
}

/** The default close message. */
export function defaultCloseMessage(): EmbedTemplate {
  return {
    color: EMBED_COLOR,
    description: "**Registration is now Closed!**",
  };
}

/** The default slotlist. */
export function defaultSlotlistFormat(): EmbedTemplate {
  return {
    color: EMBED_COLOR,
    title: "<<name>> Slotlist",
    description: "```\n<<slots>>\n```",
    footer: { text: "Registration took: <<time_taken>>" },
  };
}

/**
 * A duration, in words.
 *
 * The source stored a pre-formatted sentence ("2 hours 3 minutes") in a
 * column. Ours stores seconds (S4) and formats at render time.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "N/A";

  const total = Math.max(0, Math.floor(seconds));

  if (total === 0) return "0 seconds";

  const parts: string[] = [];

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) parts.push(plural(hours, "hour"));
  if (minutes > 0) parts.push(plural(minutes, "minute"));
  if (rest > 0) parts.push(plural(rest, "second"));

  return parts.join(", ");
}

/**
 * The slot lines of a slotlist.
 *
 * `Slot 01  ->  Team Alpha`, one per claimed slot, in slot order.
 */
export function slotListLines(slots: readonly SlotRecord[]): string {
  return slots
    .filter((slot) => slot.state === "claimed")
    .map((slot) => `Slot ${String(slot.num).padStart(2, "0")}  ->  ${slot.teamName ?? "—"}`)
    .join("\n");
}

/** The values the open message understands. */
export interface OpenMessageValues {
  readonly mentions: number;
  readonly totalSlots: number;
  readonly reservedCount: number;
  readonly slotlistMention: string;
  readonly multiregister: boolean;
  readonly teamnameCompulsion: boolean;
  readonly bannedMentions: string;
  readonly reservedMentions: string;
}

/** The values the close message understands. */
export interface CloseMessageValues {
  readonly totalSlots: number;
  readonly filled: number;
  readonly elapsedSeconds: number | null;
  readonly openTime: Date;
}

/** The values the slotlist understands. */
export interface SlotlistValues {
  readonly name: string;
  readonly elapsedSeconds: number | null;
  readonly openTime: Date;
  readonly slots: string;
}

/**
 * Turns a template into an embed.
 *
 * The substitution runs over every text the template holds — the title,
 * the description, the fields and the footer — which is what the source
 * did, because it replaced keywords across the whole serialised embed.
 */
export function renderTemplate(
  template: EmbedTemplate,
  values: KeywordValues,
): EmbedBuilder {
  const applied = applyKeywords(template, values);

  const embed = new EmbedBuilder();

  if (applied.title !== undefined) embed.setTitle(applied.title);
  if (applied.description !== undefined) embed.setDescription(applied.description);
  if (applied.color !== undefined) embed.setColor(applied.color);

  for (const field of applied.fields ?? []) {
    embed.addFields({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    });
  }

  if (applied.footer?.text !== undefined) {
    embed.setFooter({
      text: applied.footer.text,
      ...(applied.footer.icon_url
        ? { iconURL: applied.footer.icon_url }
        : {}),
    });
  }

  if (applied.image?.url !== undefined) embed.setImage(applied.image.url);

  if (applied.author?.name !== undefined) {
    embed.setAuthor({
      name: applied.author.name,
      ...(applied.author.icon_url
        ? { iconURL: applied.author.icon_url }
        : {}),
      ...(applied.author.url ? { url: applied.author.url } : {}),
    });
  }

  return embed;
}

/** Renders the open message. */
export function renderOpenMessage(
  scrim: ScrimRecord,
  values: OpenMessageValues,
): EmbedBuilder {
  const template = isEmptyTemplate(scrim.openMessage)
    ? defaultOpenMessage()
    : scrim.openMessage;

  return renderTemplate(template, {
    mentions: String(values.mentions),
    slots: String(values.totalSlots),
    reserved: String(values.reservedCount),
    slotlist: values.slotlistMention,
    multireg: values.multiregister ? "Enabled" : "Not Enabled",
    teamname: values.teamnameCompulsion ? "Yes" : "No",
    mention_banned: values.bannedMentions,
    mention_reserved: values.reservedMentions,
  });
}

/** Renders the close message. */
export function renderCloseMessage(
  scrim: ScrimRecord,
  values: CloseMessageValues,
): EmbedBuilder {
  const template = isEmptyTemplate(scrim.closeMessage)
    ? defaultCloseMessage()
    : scrim.closeMessage;

  return renderTemplate(template, {
    slots: String(values.totalSlots),
    filled: String(values.filled),
    time_taken: formatDuration(values.elapsedSeconds),
    open_time: discordTimestamp(values.openTime, "f"),
  });
}

/** Renders the slotlist. */
export function renderSlotlist(
  scrim: ScrimRecord,
  values: SlotlistValues,
): EmbedBuilder {
  const template = isEmptyTemplate(scrim.slotlistFormat)
    ? defaultSlotlistFormat()
    : scrim.slotlistFormat;

  return renderTemplate(template, {
    name: values.name,
    time_taken: formatDuration(values.elapsedSeconds),
    open_time: discordTimestamp(values.openTime, "f"),
    slots: values.slots,
  });
}
