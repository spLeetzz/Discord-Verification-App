/**
 * The shared design language.
 *
 * Every panel, button and modal in the bot is built from this file, so
 * the whole thing looks like one product rather than eight.
 *
 * **The rules.**
 *
 *  - **One primary action per panel.** The button you are most likely to
 *    want is `Primary` (blurple) and it sits alone on the first row.
 *    Everything else is grey, green or red and never competes with it.
 *  - **Colour means something.** Green is "create, confirm, open". Red is
 *    "delete, ban, purge" and nothing else. Grey is everything. A panel
 *    with two green buttons has told the user nothing.
 *  - **Rows group by meaning, not by count.** The main action is on its
 *    own row; the navigation buttons (Back, Close, Refresh) share the
 *    last row. Filling a row with five buttons because they fit is how a
 *    panel stops being readable.
 *  - **Labels are short, verb-first and unpunctuated.** "Create
 *    tournament", "Delete", "Back". A label is a button, not a sentence.
 *  - **A panel always says what to do next.** The embed's footer carries
 *    the hint, so the description does not have to shout it.
 *  - **A modal is closed by the client, not by a button.** Discord's modal
 *    API takes text inputs and nothing else — a button inside a modal is
 *    rejected by the API. Every modal therefore gets its way out from the
 *    client: Escape, or the X in the corner. The panel that opened the
 *    modal is what has to carry a visible way back, and it always does.
 *
 * **Emoji.** The default is none. A label is clearer than an emoji, and
 * the bot's panels have a lot of buttons in them. Emoji is for the cases
 * where it carries meaning on its own — a status dot, a reaction — and
 * every helper takes one optionally.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";
import { EMBED_COLOR, ERROR_COLOR } from "./constants.js";

/* ------------------------------------------------------------------ *
 * Discord's limits
 * ------------------------------------------------------------------ */

/** How many buttons fit in one row. */
export const MAX_BUTTONS_PER_ROW = 5;

/** How many rows a message may carry. */
export const MAX_COMPONENT_ROWS = 5;

/** How long a modal's title may be. */
export const MAX_MODAL_TITLE = 45;

/** How long a text input's label may be. */
export const MAX_INPUT_LABEL = 45;

/** How long a text input's placeholder may be. */
export const MAX_PLACEHOLDER = 100;

/** How long a text input's value may be. */
export const MAX_INPUT_VALUE = 4000;

/** How many inputs a modal may carry. */
export const MAX_MODAL_INPUTS = 5;

/* ------------------------------------------------------------------ *
 * Colours
 * ------------------------------------------------------------------ */

/** The colour of an ordinary panel. */
export const PANEL_COLOR = EMBED_COLOR;

/** The colour of a panel that is reporting a problem. */
export const DANGER_COLOR = ERROR_COLOR;

/** The colour of a panel that is reporting a good outcome. */
export const SUCCESS_COLOR = 0x2ecc71;

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

/** What every button helper takes. */
export interface ButtonOptions {
  /** The id the router dispatches on. */
  readonly customId: string;
  /** The label on the button. At most 80 characters. */
  readonly label?: string;
  /** An emoji, for the cases where it carries meaning on its own. */
  readonly emoji?: string;
  /** Whether the button is greyed out. */
  readonly disabled?: boolean;
}

function buildButton(
  style: ButtonStyle,
  options: ButtonOptions,
): ButtonBuilder {
  const builder = new ButtonBuilder()
    .setCustomId(options.customId)
    .setStyle(style);

  if (options.label) builder.setLabel(options.label.slice(0, 80));
  if (options.emoji) builder.setEmoji(options.emoji);
  if (options.disabled !== undefined) builder.setDisabled(options.disabled);

  return builder;
}

/**
 * The main action of a panel.
 *
 * One per panel. It is the button the user is most likely to want, and
 * it is the only button on the screen that is not grey, green or red.
 */
export function primaryButton(options: ButtonOptions): ButtonBuilder {
  return buildButton(ButtonStyle.Primary, options);
}

/** A neutral action. The default. */
export function secondaryButton(options: ButtonOptions): ButtonBuilder {
  return buildButton(ButtonStyle.Secondary, options);
}

/**
 * An action that creates, confirms or opens something.
 *
 * Green means "this adds something" — create a tournament, open
 * registration, confirm a change. It does not mean "go to the next
 * screen".
 */
export function successButton(options: ButtonOptions): ButtonBuilder {
  return buildButton(ButtonStyle.Success, options);
}

/**
 * An action that destroys something.
 *
 * Red is only for actions that cannot be undone: delete, ban, purge,
 * cancel a running thing. If a button is red, the user should hesitate.
 */
export function dangerButton(options: ButtonOptions): ButtonBuilder {
  return buildButton(ButtonStyle.Danger, options);
}

/**
 * A link to somewhere else.
 *
 * The one button that cannot carry a custom id: it opens a URL rather
 * than doing something in the bot, so there is nothing for the router to
 * dispatch on.
 */
export function linkButton(options: {
  readonly url: string;
  readonly label: string;
  readonly emoji?: string;
}): ButtonBuilder {
  const builder = new ButtonBuilder()
    .setURL(options.url)
    .setStyle(ButtonStyle.Link)
    .setLabel(options.label.slice(0, 80));

  if (options.emoji) builder.setEmoji(options.emoji);

  return builder;
}

/**
 * Checks a message's components against Discord's budget.
 *
 * **Why this is checked centrally.** Discord allows five rows of
 * components per message, and five components in a row. A panel that
 * goes over is refused by the API with an opaque 400, and the panel
 * simply does not appear — the moderator presses a button and *nothing
 * happens*. That is exactly the kind of failure that reaches a user as
 * "the bot is broken".
 *
 * A panel over the row limit once shipped, so the check is made where
 * the message is sent rather than in each area's own builder: an area
 * that forgets it gets a clear error instead of a silent failure.
 *
 * @throws RangeError when the message is over budget.
 */
export function assertComponentBudget(rows: readonly unknown[]): void {
  if (rows.length > MAX_COMPONENT_ROWS) {
    throw new RangeError(
      `a message may hold at most ${MAX_COMPONENT_ROWS} rows, got ${rows.length}`,
    );
  }

  for (const [index, row] of rows.entries()) {
    const components = (row as { components?: unknown }).components;

    // A row that is not a row of components is not ours to count.
    if (!Array.isArray(components)) continue;

    if (components.length > MAX_BUTTONS_PER_ROW) {
      throw new RangeError(
        `row ${index + 1} may hold at most ${MAX_BUTTONS_PER_ROW} components, got ${components.length}`,
      );
    }
  }
}

/**
 * A row of any component.
 *
 * `actionRow` is for buttons. A select menu cannot go in a button row —
 * Discord types the row by what it holds — so a menu gets its own row
 * through this.
 */
export function componentRow<
  T extends
    | ButtonBuilder
    | StringSelectMenuBuilder
    | ChannelSelectMenuBuilder
    | RoleSelectMenuBuilder
    | UserSelectMenuBuilder
    | MentionableSelectMenuBuilder,
>(
  ...components: readonly T[]
): ActionRowBuilder<T> {
  if (components.length > MAX_BUTTONS_PER_ROW) {
    throw new RangeError(
      `a row may hold at most ${MAX_BUTTONS_PER_ROW} components, got ${components.length}`,
    );
  }

  return new ActionRowBuilder<T>().addComponents(...components);
}

/**
 * A row of buttons.
 *
 * @throws RangeError when the row holds more than Discord allows.
 */
export function actionRow(
  ...buttons: readonly ButtonBuilder[]
): ActionRowBuilder<ButtonBuilder> {
  if (buttons.length > MAX_BUTTONS_PER_ROW) {
    throw new RangeError(
      `a row may hold at most ${MAX_BUTTONS_PER_ROW} buttons, got ${buttons.length}`,
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * The row of buttons that ends a panel.
 *
 * Back, Close, Refresh — the navigation. It always goes last, and it is
 * always grey, so the eye lands on the real action first.
 */
export function navigationRow(
  ...buttons: readonly ButtonBuilder[]
): ActionRowBuilder<ButtonBuilder> {
  return actionRow(...buttons);
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

/** One field of a modal. */
export interface TextInputSpec {
  /** The id the modal handler reads the value from. */
  readonly id: string;
  /** The label above the field. At most 45 characters. */
  readonly label: string;
  /** An example of what to type. */
  readonly placeholder?: string;
  /** The value the field starts with. */
  readonly value?: string;
  /** Whether the field must be filled in. */
  readonly required?: boolean;
  /** The shortest value that is accepted. */
  readonly minLength?: number;
  /** The longest value that is accepted. */
  readonly maxLength?: number;
  /**
   * One line or many.
   *
   * Defaults to `Short` for a field of ten characters or fewer and
   * `Paragraph` above that, which is the line Discord draws — so the
   * field is as tall as the answer is long.
   */
  readonly style?: TextInputStyle;
}

/**
 * One field of a modal.
 *
 * @throws RangeError when the label is longer than Discord allows.
 */
export function textInput(spec: TextInputSpec): TextInputBuilder {
  if (spec.label.length > MAX_INPUT_LABEL) {
    throw new RangeError(
      `a text input label may be at most ${MAX_INPUT_LABEL} characters`,
    );
  }

  const style =
    spec.style ??
    (spec.maxLength !== undefined && spec.maxLength > 10
      ? TextInputStyle.Paragraph
      : TextInputStyle.Short);

  const input = new TextInputBuilder()
    .setCustomId(spec.id)
    .setLabel(spec.label)
    .setStyle(style);

  if (spec.value) input.setValue(spec.value.slice(0, MAX_INPUT_VALUE));
  if (spec.placeholder) {
    input.setPlaceholder(spec.placeholder.slice(0, MAX_PLACEHOLDER));
  }
  if (spec.required !== undefined) input.setRequired(spec.required);
  if (spec.minLength !== undefined) {
    input.setMinLength(Math.max(0, spec.minLength));
  }
  if (spec.maxLength !== undefined) {
    input.setMaxLength(Math.min(spec.maxLength, MAX_INPUT_VALUE));
  }

  return input;
}

/** How a modal is shaped. */
export interface ModalSpec {
  /** The id the modal handler is dispatched on. */
  readonly customId: string;
  /** The title in the modal's header. At most 45 characters. */
  readonly title: string;
  /** The fields, in the order they are shown. */
  readonly inputs: readonly TextInputSpec[];
}

/**
 * A modal.
 *
 * @throws RangeError when the title is too long, or when there are no
 *         fields, or when there are too many of them.
 */
export function buildModal(spec: ModalSpec): ModalBuilder {
  if (spec.title.length > MAX_MODAL_TITLE) {
    throw new RangeError(
      `a modal title may be at most ${MAX_MODAL_TITLE} characters`,
    );
  }

  if (spec.inputs.length === 0) {
    throw new RangeError("a modal needs at least one field");
  }

  if (spec.inputs.length > MAX_MODAL_INPUTS) {
    throw new RangeError(
      `a modal may hold at most ${MAX_MODAL_INPUTS} fields, got ${spec.inputs.length}`,
    );
  }

  const modal = new ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title);

  for (const input of spec.inputs) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(textInput(input)),
    );
  }

  return modal;
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

/** One field of a panel's embed. */
export interface PanelField {
  readonly name: string;
  readonly value: string;
  /** Whether the name is shown inline beside the value. */
  readonly inline?: boolean;
}

/** How a panel's embed is shaped. */
export interface PanelEmbedSpec {
  /** The title at the top. */
  readonly title: string;
  /** The text under the title. */
  readonly description?: string;
  /** The fields under the description. */
  readonly fields?: readonly PanelField[];
  /** The colour. Defaults to the ordinary panel colour. */
  readonly color?: number;
  /** The small text at the bottom — usually the hint about what to do next. */
  readonly footer?: string;
  /** The name shown beside the footer. */
  readonly footerIcon?: string;
}

/**
 * The embed of a panel.
 *
 * The footer is where the hint goes, so the description can stay short
 * and readable instead of ending with a paragraph of instructions.
 */
export function panelEmbed(spec: PanelEmbedSpec): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(spec.title)
    .setColor(spec.color ?? PANEL_COLOR);

  if (spec.description) embed.setDescription(spec.description);
  if (spec.fields) embed.addFields(spec.fields.map((f) => ({ ...f })));

  if (spec.footer) {
    embed.setFooter({
      text: spec.footer,
      ...(spec.footerIcon ? { iconURL: spec.footerIcon } : {}),
    });
  }

  return embed;
}

/** A message: an embed and the rows under it. */
export interface Panel {
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
}

/**
 * A panel that says there is nothing here yet.
 *
 * The empty state is the first thing a new user sees, so it says what to
 * do rather than just reporting the absence.
 */
export function emptyPanel(options: {
  readonly title: string;
  readonly description: string;
  readonly footer?: string;
  readonly action?: ButtonBuilder;
}): Panel {
  const embed = panelEmbed({
    title: options.title,
    description: options.description,
    ...(options.footer ? { footer: options.footer } : {}),
  });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (options.action) components.push(actionRow(options.action));

  return { embeds: [embed], components };
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/**
 * A short, sentence-cased label.
 *
 * The first letter is capitalised and nothing else is changed, so a
 * label that is already written the way it should be comes back
 * unchanged.
 */
export function label(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) return trimmed;

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
