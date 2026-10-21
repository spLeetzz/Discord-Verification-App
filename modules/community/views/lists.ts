/**
 * The community area's lists.
 *
 * A tag is a short thing, and the panel that shows a tag is a list. The
 * list **is** the panel: it has to read cleanly at a glance, and the one
 * action it offers has to be obvious.
 *
 * The rows are built here, so every list in the area is laid out the
 * same way. The paginator's own footer carries the page count, so the
 * hint about what to do with the list goes above it, in the header.
 */

import { escapeMarkdown } from "../../../core/escape.js";
import { discordTimestamp } from "../../../core/time.js";
import { truncate } from "../../../core/text.js";
import type { ReminderRecord, TagRecord } from "../types.js";

/**
 * The header of a tag list.
 *
 * The one action of a tag list is posting a tag, so that is what the
 * header names.
 */
export const TAG_LIST_HEADER: readonly string[] = [
  "Post one with `/tag show <name>`.",
];

/**
 * The header of a reminder list.
 *
 * The one action of a reminder list is getting rid of a reminder, and
 * that is why the list shows the id: it is the part of the reminder
 * `/reminder delete` needs.
 */
export const REMINDER_LIST_HEADER: readonly string[] = [
  "Delete one with `/reminder delete`.",
];

/**
 * The pages of a list of tags.
 *
 * @param tags   the tags of the list.
 * @param perPage how many tags go on a page.
 * @param header the lines above the list.
 */
export function tagListPages(
  tags: readonly TagRecord[],
  perPage: number,
  header: readonly string[] = TAG_LIST_HEADER,
): string[][] {
  const rows = tags.map((tag, index) => {
    const number = String(index + 1).padStart(2, "0");

    // The name is the member's own text, so it is escaped: a tag called
    // `*rules*` must not turn the list into italics.
    return `\`${number}\` **${escapeMarkdown(tag.name)}** — \`${tag.id}\``;
  });

  return chunk(rows, perPage).map((page) => [...header, "", ...page]);
}

/**
 * The pages of a list of reminders.
 *
 * @param reminders the reminders of the list.
 * @param header    the lines above the list.
 */
export function reminderListPages(
  reminders: readonly ReminderRecord[],
  header: readonly string[] = REMINDER_LIST_HEADER,
): string[][] {
  const rows = reminders.map(
    (row) =>
      `\`${row.id}\` — ${truncate(row.message, 40)} (${discordTimestamp(row.expiresAt)})`,
  );

  return [[...header, "", ...rows]];
}

/**
 * Splits a list of lines into pages.
 */
function chunk(lines: readonly string[], perPage: number): string[][] {
  const pages: string[][] = [];

  const size = perPage > 0 ? perPage : 1;

  for (let index = 0; index < lines.length; index += size) {
    pages.push(lines.slice(index, index + size));
  }

  return pages;
}
