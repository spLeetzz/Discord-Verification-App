/**
 * Waiting for a select menu.
 *
 * Quotient's select menus wrote the chosen value onto the view object
 * (`self.custom_id = interaction.data["values"][0]`) and the caller read it
 * back, sometimes packing two ids into one string
 * (`"slot_id:tourney_id"`). That is the `custom_id` string-packing hack
 * D35 removes: here the value comes back as a plain array of strings.
 *
 * The menu is owned by the caller — only the member who opened it may
 * choose — and the custom id carries a token so two menus open in the
 * same channel cannot be answered by the same click.
 */

import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  SelectMenuOptionBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { RepliableInteraction } from "discord.js";
import { respond } from "./context.js";
import { randomId } from "./custom-id.js";
import { EMBED_COLOR } from "./constants.js";

/** The prefix every select-menu custom id starts with. */
export const SELECT_CUSTOM_ID_PREFIX = "core:select";

/** How long a menu stays open by default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Discord's own limits. */
const MAX_OPTIONS = 25;
const MAX_LABEL_LENGTH = 100;
const MAX_VALUE_LENGTH = 100;

/** One choice in the menu. */
export interface SelectOption {
  /** The text the user reads. At most 100 characters. */
  label: string;
  /** The value handed back to the caller. At most 100 characters. */
  value: string;
  /** A smaller line under the label. */
  description?: string;
  /** The emoji next to the label. */
  emoji?: string;
  /** Whether this option starts out selected. */
  default?: boolean;
}

/** How the menu is shaped. */
export interface AwaitSelectOptions {
  /**
   * How many values the user may choose.
   *
   * Defaults to 1. Discord allows up to 25.
   */
  maxValues?: number;
  /**
   * How long the menu stays open, in milliseconds.
   *
   * Defaults to 60 seconds.
   */
  timeoutMs?: number;
  /** The greyed-out text on the menu. */
  placeholder?: string;
  /** The question shown above the menu. */
  question?: string;
  /**
   * Make the menu ephemeral.
   *
   * Only has an effect when the interaction has not been replied to yet.
   */
  ephemeral?: boolean;
}

/**
 * Opens a select menu and waits for the user to choose.
 *
 * @returns the chosen values, in the order the user chose them. An empty
 *          array means the menu timed out or nobody chose anything.
 */
export async function awaitSelect(
  interaction: RepliableInteraction,
  options: readonly SelectOption[],
  settings: AwaitSelectOptions = {},
): Promise<string[]> {
  if (options.length === 0) {
    throw new TypeError("awaitSelect needs at least one option");
  }

  if (options.length > MAX_OPTIONS) {
    throw new RangeError(
      `awaitSelect accepts at most ${MAX_OPTIONS} options, got ${options.length}`,
    );
  }

  const maxValues = settings.maxValues ?? 1;

  if (maxValues < 1 || maxValues > MAX_OPTIONS) {
    throw new RangeError(
      `awaitSelect needs maxValues between 1 and ${MAX_OPTIONS}, got ${maxValues}`,
    );
  }

  for (const option of options) {
    if (option.label.length > MAX_LABEL_LENGTH) {
      throw new RangeError(
        `A select option's label may be at most ${MAX_LABEL_LENGTH} characters`,
      );
    }

    if (option.value.length > MAX_VALUE_LENGTH) {
      throw new RangeError(
        `A select option's value may be at most ${MAX_VALUE_LENGTH} characters`,
      );
    }
  }

  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const customId = `${SELECT_CUSTOM_ID_PREFIX}:${randomId()}`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(settings.placeholder ?? "Choose an option")
    .setMinValues(1)
    .setMaxValues(Math.min(maxValues, options.length));

  for (const option of options) {
    const builder = new SelectMenuOptionBuilder()
      .setLabel(option.label)
      .setValue(option.value);

    if (option.description) builder.setDescription(option.description);
    if (option.emoji) builder.setEmoji(option.emoji);
    if (option.default) builder.setDefault(true);

    menu.addOptions(builder);
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    menu,
  );

  const handle = await respond(
    interaction,
    settings.question
      ? {
          embeds: [
            new EmbedBuilder()
              .setDescription(settings.question)
              .setColor(EMBED_COLOR),
          ],
          components: [row],
        }
      : { components: [row] },
    settings.ephemeral ?? false,
  );

  try {
    const answer = await handle.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: timeoutMs,
      filter: (candidate) => candidate.customId === customId,
    });

    const values = answer.isStringSelectMenu() ? answer.values : [];

    await answer.update({ components: [] });

    return values;
  } catch {
    // Timed out. Nobody chose anything.
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // The interaction expired. Nothing to clean up.
    }

    return [];
  }
}
