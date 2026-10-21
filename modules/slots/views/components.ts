/**
 * The pieces of the slot panels the shared design language does not have.
 *
 * The buttons, the rows, the modals and the embeds come from
 * `core/ui.ts` — that file is the one design language the whole bot
 * speaks, and the slot area does not get a second one. What is left
 * here are the two things core does not have: a row for a select menu,
 * and the check that a panel stays inside Discord's component budget.
 *
 * **The component budget is real.** Discord allows 25 components per
 * message, five rows, and five buttons per row, so a panel that would
 * break those limits fails in development rather than in production.
 */

import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

/** Discord's own limits. */
export const MAX_ROWS = 5;
export const MAX_COMPONENTS_PER_ROW = 5;
export const MAX_COMPONENTS_PER_MESSAGE = 25;

/** A row that holds one select menu. */
export function selectRow(
  menu: StringSelectMenuBuilder,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * Counts the components of a set of rows.
 *
 * The layout is checked at build time, so a panel that would break
 * Discord's limits fails in development rather than in production.
 */
export function assertComponentBudget(
  rows: readonly { readonly components: readonly unknown[] }[],
): void {
  if (rows.length > MAX_ROWS) {
    throw new RangeError(
      `a message may hold at most ${MAX_ROWS} rows, got ${rows.length}`,
    );
  }

  const total = rows.reduce((sum, row) => sum + row.components.length, 0);

  if (total > MAX_COMPONENTS_PER_MESSAGE) {
    throw new RangeError(
      `a message may hold at most ${MAX_COMPONENTS_PER_MESSAGE} components, got ${total}`,
    );
  }
}
