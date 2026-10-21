/**
 * The embed designer.
 *
 * Quotient's embed builder (`src/core/embeds.py`) is a select menu with
 * five options — the message itself, the thumbnail, the image, the footer
 * icon and the colour — and each option opens a modal.
 *
 * Three things are different here:
 *
 *  - The stored value is a **plain JSON object** (D32). Quotient stored
 *    `discord.Embed.to_dict()` as a Python literal string and re-parsed it
 *    with `ast.literal_eval` on every render, so a template written by
 *    another code path crashed the next render. This module stores JSON
 *    and parses it with `JSON.parse`.
 *  - The designer keeps its state in a token (D18). The template being
 *    edited has no database row yet — it is a wizard mid-flight — so the
 *    modal's custom id carries a token into an in-memory map.
 *  - The draft remembers **who started it**. The select that drives the
 *    designer carries the token, and the token is in the message, so
 *    anybody in the channel can drive somebody else's draft. A modal is
 *    different: Discord only lets the person who opened it submit it, so
 *    the select is the exposed one, and the draft's owner is what stops
 *    it.
 *
 * The designer is **wired by core**. Its custom ids carry the `embeds`
 * prefix, and this module registers that prefix with the router — the
 * select, the modal, and the save button. An area that uses the
 * designer does not have to know that the prefix needs registering,
 * which is how a feature ends up wired to nothing.
 *
 * The **panel** is the designer's: the embed being edited, the select
 * menu, and the save button. The designer posts it and keeps the handle
 * to it, so the re-render after an edit lands on the message that
 * actually carries the panel — the reply, or the follow-up the panel
 * was sent as.
 */

import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  RepliableInteraction,
} from "discord.js";
import { TokenStore } from "./custom-id.js";
import {
  PANEL_COLOR,
  actionRow,
  buildModal,
  panelEmbed,
  primaryButton,
} from "./ui.js";
import { replyError, replySuccess, respond } from "./context.js";
import type { ReplyHandle, ReplyPayload } from "./context.js";
import { OWNER_DENIAL_MESSAGE } from "./guards.js";
import {
  registerButton,
  registerModal,
  registerSelect,
  registeredPrefixes,
} from "./router.js";
import { logger } from "../utils/logger.js";

/**
 * The prefix the designer's custom ids carry.
 */
export const EMBED_DESIGNER_PREFIX = "embeds";

/**
 * The action in the select menu's custom id.
 *
 * The router dispatches on the prefix, so the handler still has to say
 * which action of the prefix it is answering.
 */
export const EMBED_DESIGNER_SELECT_ACTION = "options";

/**
 * The action in the save button's custom id.
 */
export const EMBED_DESIGNER_SAVE_ACTION = "save";

/**
 * The five things the designer can edit.
 */
export const EMBED_EDIT_TARGETS = {
  /** The title, the description and the footer text. */
  main: "main",
  /** The small image on the right. */
  thumbnail: "thumb",
  /** The big image. */
  image: "image",
  /** The small icon next to the footer. */
  footerIcon: "footer_icon",
  /** The colour of the embed's bar. */
  color: "color",
} as const;

/** One of the five edit targets. */
export type EmbedEditTarget =
  (typeof EMBED_EDIT_TARGETS)[keyof typeof EMBED_EDIT_TARGETS];

/**
 * An embed, as it is stored.
 *
 * This is the shape that goes into the `jsonb` column (D32). Every field
 * is optional: an absent field means "not set", which is different from an
 * empty string.
 */
export interface EmbedTemplate {
  /** The text above the embed. */
  title?: string;
  /** The body of the embed. */
  description?: string;
  /** The colour of the bar, as a number. */
  color?: number;
  /** The URL of the small image on the right. */
  thumbnailUrl?: string;
  /** The URL of the big image. */
  imageUrl?: string;
  /** The text at the bottom. */
  footerText?: string;
  /** The URL of the icon next to the footer text. */
  footerIconUrl?: string;
}

/**
 * The colour names the designer accepts.
 *
 * Quotient used PIL's `ImageColor.getrgb`, which knows every CSS colour
 * name. This is a smaller table: the sixteen basic HTML colours and
 * Discord's own palette. A hex value or an `r,g,b` triple always works.
 */
const COLOUR_NAMES: Readonly<Record<string, number>> = {
  black: 0x000000,
  silver: 0xc0c0c0,
  gray: 0x808080,
  grey: 0x808080,
  white: 0xffffff,
  maroon: 0x800000,
  red: 0xff0000,
  purple: 0x800080,
  fuchsia: 0xff00ff,
  magenta: 0xff00ff,
  green: 0x008000,
  lime: 0x00ff00,
  olive: 0x808000,
  yellow: 0xffff00,
  navy: 0x000080,
  blue: 0x0000ff,
  teal: 0x008080,
  aqua: 0x00ffff,
  cyan: 0x00ffff,
  orange: 0xffa500,
  pink: 0xffc0cb,
  brown: 0xa52a2a,
  gold: 0xffd700,
  indigo: 0x4b0082,
  violet: 0xee82ee,
  turquoise: 0x40e0d0,
  greyple: 0x99aab5,
  grayple: 0x99aab5,
  dark: 0x2c2f33,
  "dark-but-not-black": 0x2c2f33,
  blurple: 0x5865f2,
  "og-blurple": 0xfaa61a,
  discord: 0x5865f2,
  "discord-green": 0x57f287,
  "discord-red": 0xed4245,
  "discord-yellow": 0xfee75c,
  "discord-blue": 0x3498db,
  "discord-purple": 0x9b59b6,
  "discord-orange": 0xe67e22,
};

/**
 * Parses a colour.
 *
 * Three forms are accepted: `r,g,b` (as Quotient's converter did), a hex
 * value with or without a `#`, and a colour name.
 *
 * @returns the colour as a number, or `null` when the input is not a
 *          colour.
 */
export function parseEmbedColor(input: string): number | null {
  const text = input.trim().toLowerCase();

  if (!text) return null;

  const triple = /^\(?(\d{1,3}),?\s*(\d{1,3}),?\s*(\d{1,3})\)?$/.exec(text);

  if (triple) {
    const red = Number(triple[1] ?? "0");
    const green = Number(triple[2] ?? "0");
    const blue = Number(triple[3] ?? "0");

    if (
      [red, green, blue].every((part) => part >= 0 && part <= 255)
    ) {
      return (red << 16) | (green << 8) | blue;
    }

    return null;
  }

  const hex = /^#?([0-9a-f]{6})$/.exec(text) ?? /^0x([0-9a-f]{6})$/.exec(text);

  if (hex) {
    return Number.parseInt(hex[1] ?? "0", 16);
  }

  return COLOUR_NAMES[text] ?? null;
}

/**
 * Renders a stored template as an embed.
 *
 * This is the one function that turns a stored template into something
 * Discord can show (D32).
 *
 * A template is the user's own embed, so it is rendered as it was
 * written: a template with no title has no title. The panel helper is
 * for the panels the bot builds, and every panel has a title — so a
 * template without one is built on its own.
 */
export function embedTemplateToBuilder(template: EmbedTemplate): EmbedBuilder {
  const embed = template.title
    ? panelEmbed({ title: template.title, color: template.color })
    : new EmbedBuilder().setColor(template.color ?? PANEL_COLOR);

  if (template.description) embed.setDescription(template.description);

  // A footer may carry an icon and no text. Discord will not take a
  // footer with empty text, so a template with an icon and no words
  // gets no footer at all.
  if (template.footerText) {
    embed.setFooter({
      text: template.footerText,
      ...(template.footerIconUrl ? { iconURL: template.footerIconUrl } : {}),
    });
  }

  if (template.thumbnailUrl) embed.setThumbnail(template.thumbnailUrl);
  if (template.imageUrl) embed.setImage(template.imageUrl);

  return embed;
}

/**
 * Serialises a template for storage.
 *
 * JSON, never a Python literal string (D32).
 */
export function embedTemplateToJSON(template: EmbedTemplate): string {
  const clean: EmbedTemplate = {};

  if (template.title !== undefined) clean.title = template.title;
  if (template.description !== undefined) clean.description = template.description;
  if (template.color !== undefined) clean.color = template.color;
  if (template.thumbnailUrl !== undefined) clean.thumbnailUrl = template.thumbnailUrl;
  if (template.imageUrl !== undefined) clean.imageUrl = template.imageUrl;
  if (template.footerText !== undefined) clean.footerText = template.footerText;
  if (template.footerIconUrl !== undefined) clean.footerIconUrl = template.footerIconUrl;

  return JSON.stringify(clean);
}

/**
 * Reads a stored template.
 *
 * @returns the template, or `null` when the stored value is not a
 *          template. A malformed template must not crash the render — it
 *          is data, and data can be wrong.
 */
export function parseEmbedTemplate(raw: string): EmbedTemplate | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const source = parsed as Record<string, unknown>;
  const template: EmbedTemplate = {};

  const readString = (key: string): string | undefined => {
    const value = source[key];

    return typeof value === "string" ? value : undefined;
  };

  const title = readString("title");
  const description = readString("description");
  const thumbnailUrl = readString("thumbnailUrl");
  const imageUrl = readString("imageUrl");
  const footerText = readString("footerText");
  const footerIconUrl = readString("footerIconUrl");

  if (title !== undefined) template.title = title;
  if (description !== undefined) template.description = description;
  if (thumbnailUrl !== undefined) template.thumbnailUrl = thumbnailUrl;
  if (imageUrl !== undefined) template.imageUrl = imageUrl;
  if (footerText !== undefined) template.footerText = footerText;
  if (footerIconUrl !== undefined) template.footerIconUrl = footerIconUrl;

  if (typeof source["color"] === "number" && Number.isFinite(source["color"])) {
    template.color = source["color"];
  }

  return template;
}

/**
 * A draft being designed.
 *
 * The template as it stands, and the member who started it. The owner is
 * part of the draft, not part of the message: the message is in a channel
 * other people can read, so the token in the custom id is not a secret
 * and cannot be the guard.
 */
export interface EmbedDraft {
  /** The template as it stands. */
  readonly template: EmbedTemplate;
  /** The id of the member who started the draft. */
  readonly ownerId: string;
  /**
   * The panel the draft is shown on.
   *
   * `null` for a draft whose panel the caller renders itself. The
   * re-render then lands on the message the modal was opened from,
   * which is that panel.
   */
  readonly panel: ReplyHandle | null;
  /**
   * What to do when the design is saved.
   *
   * `null` when the draft has nothing to save — a draft made without a
   * save action has no save button on its panel.
   */
  readonly onSave: EmbedSaveHandler | null;
}

/**
 * How a design session is opened.
 */
export interface EmbedOpenOptions {
  /** The template the draft starts from. */
  readonly template: EmbedTemplate;
  /**
   * The member who starts the draft. Only that member may drive it.
   */
  readonly ownerId: string;
  /**
   * What to do when the design is saved.
   */
  readonly onSave: EmbedSaveHandler;
}

/**
 * The custom id of the select menu that drives the designer.
 *
 * The token travels in it, because the menu is what a member of the
 * channel can press, and the handler has to know which draft they are
 * pressing it for.
 */
export function embedDesignerSelectCustomId(
  token: string,
  prefix = EMBED_DESIGNER_PREFIX,
): string {
  return `${prefix}:options:${token}`;
}

/**
 * The custom id of the modal for one edit target.
 */
export function embedDesignerModalCustomId(
  target: EmbedEditTarget,
  token: string,
  prefix = EMBED_DESIGNER_PREFIX,
): string {
  return `${prefix}:${target}:${token}`;
}

/**
 * The custom id of the button that saves the design.
 *
 * The save button is the designer's: what a design is *for* is the
 * area's business, so the area hands the designer the action to run
 * when the owner presses it.
 */
export function embedDesignerSaveCustomId(
  token: string,
  prefix = EMBED_DESIGNER_PREFIX,
): string {
  return `${prefix}:${EMBED_DESIGNER_SAVE_ACTION}:${token}`;
}

/**
 * What happens when the design is saved.
 *
 * The designer does not know what a design is for — that is the area's
 * business — so the area hands the designer the action to run when the
 * owner presses Save.
 *
 * The interaction is passed along so the area can say what it saved
 * ("saved as the open message of scrim X"). When the area has already
 * answered the interaction, the designer keeps quiet.
 */
export type EmbedSaveHandler = (
  template: EmbedTemplate,
  interaction: ButtonInteraction,
) => Promise<void> | void;

/**
 * Builds the select menu with the five edit targets.
 *
 * @param token the draft the menu drives. It travels in the custom id.
 */
export function buildEmbedDesignerOptions(
  token: string,
  prefix = EMBED_DESIGNER_PREFIX,
): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(embedDesignerSelectCustomId(token, prefix))
    .setPlaceholder("Pick what to edit")
    .addOptions(
      {
        label: "Edit message",
        value: EMBED_EDIT_TARGETS.main,
        description: "The title, the description and the footer.",
      },
      {
        label: "Edit thumbnail",
        value: EMBED_EDIT_TARGETS.thumbnail,
        description: "The small image on the right of the embed.",
      },
      {
        label: "Edit main image",
        value: EMBED_EDIT_TARGETS.image,
        description: "The big image under the embed.",
      },
      {
        label: "Edit footer icon",
        value: EMBED_EDIT_TARGETS.footerIcon,
        description: "The small icon next to the footer.",
      },
      {
        label: "Set color",
        value: EMBED_EDIT_TARGETS.color,
        description: "Change the color of the embed.",
      },
    );
}

/**
 * Builds the modal for one edit target.
 *
 * @param target   what is being edited.
 * @param template the template as it stands, used as the default value of
 *                 every field.
 * @param token    the wizard's token, carried in the custom id.
 */
export function buildEmbedDesignerModal(
  target: EmbedEditTarget,
  template: EmbedTemplate,
  token: string,
  prefix = EMBED_DESIGNER_PREFIX,
): ModalBuilder {
  const customId = embedDesignerModalCustomId(target, token, prefix);

  if (target === EMBED_EDIT_TARGETS.main) {
    return buildModal({
      customId,
      title: EMBED_EDIT_TARGET_TITLES[target],
      inputs: [
        {
          id: "title",
          label: "Title",
          placeholder: "e.g. Match schedule",
          value: template.title ?? "",
          required: false,
          maxLength: 256,
          style: TextInputStyle.Short,
        },
        {
          id: "description",
          label: "Description",
          placeholder: "e.g. The times of every match in the bracket",
          value: template.description ?? "",
          required: false,
          maxLength: 4000,
          style: TextInputStyle.Paragraph,
        },
        {
          id: "footer",
          label: "Footer",
          placeholder: "e.g. Updated every hour",
          value: template.footerText ?? "",
          required: false,
          maxLength: 2048,
          style: TextInputStyle.Paragraph,
        },
      ],
    });
  }

  if (target === EMBED_EDIT_TARGETS.color) {
    return buildModal({
      customId,
      title: EMBED_EDIT_TARGET_TITLES[target],
      inputs: [
        {
          id: "color",
          label: "Color",
          placeholder: "e.g. red, #00ffb3 or 0,255,179",
          value:
            template.color === undefined
              ? ""
              : `#${template.color.toString(16).padStart(6, "0")}`,
          required: false,
          maxLength: 32,
          style: TextInputStyle.Short,
        },
      ],
    });
  }

  const urlKey = EMBED_EDIT_TARGET_URLS[target];

  return buildModal({
    customId,
    title: EMBED_EDIT_TARGET_TITLES[target],
    inputs: [
      {
        id: "url",
        label: "Image URL",
        placeholder: "e.g. https://example.com/image.png — leave empty to remove",
        value: template[urlKey] ?? "",
        required: false,
        maxLength: 1024,
        style: TextInputStyle.Short,
      },
    ],
  });
}

/** The title of the modal for each edit target. */
const EMBED_EDIT_TARGET_TITLES: Readonly<
  Record<(typeof EMBED_EDIT_TARGETS)[keyof typeof EMBED_EDIT_TARGETS], string>
> = {
  main: "Edit message",
  thumb: "Edit thumbnail",
  image: "Edit main image",
  footer_icon: "Edit footer icon",
  color: "Set color",
};

/** The template field each image target writes to. */
const EMBED_EDIT_TARGET_URLS: Readonly<
  Record<
    "thumb" | "image" | "footer_icon",
    "thumbnailUrl" | "imageUrl" | "footerIconUrl"
  >
> = {
  thumb: "thumbnailUrl",
  image: "imageUrl",
  footer_icon: "footerIconUrl",
};

/**
 * The fields the modal for one target carries.
 *
 * The ids are the ones `buildEmbedDesignerModal` gives the inputs, and
 * they are the ones `applyEmbedEdit` reads.
 */
const EMBED_EDIT_TARGET_FIELDS: Readonly<
  Record<EmbedEditTarget, readonly string[]>
> = {
  main: ["title", "description", "footer"],
  thumb: ["url"],
  image: ["url"],
  footer_icon: ["url"],
  color: ["color"],
};

/**
 * The five edit targets, as a list.
 *
 * A value that came off a select menu is data, and data can be wrong:
 * the check is a lookup in this list, not a cast.
 */
const EMBED_EDIT_TARGET_VALUES: readonly string[] =
  Object.values(EMBED_EDIT_TARGETS);

/**
 * A URL is only accepted when it is an `https` URL, as in Quotient.
 */
function cleanUrl(value: string | undefined): string | undefined {
  const text = value?.trim();

  if (!text) return undefined;
  if (!text.startsWith("https://")) return undefined;

  return text;
}

/**
 * Applies one edit to a template.
 *
 * @param target what was edited.
 * @param values the modal's fields, by their custom id.
 */
export function applyEmbedEdit(
  target: EmbedEditTarget,
  template: EmbedTemplate,
  values: Readonly<Record<string, string>>,
): EmbedTemplate {
  const next: EmbedTemplate = { ...template };

  if (target === EMBED_EDIT_TARGETS.main) {
    const title = values["title"]?.trim();
    const description = values["description"];
    const footer = values["footer"]?.trim();

    if (title) next.title = title;
    else delete next.title;

    if (description) next.description = description;
    else delete next.description;

    if (footer) next.footerText = footer;
    else delete next.footerText;

    return next;
  }

  if (target === EMBED_EDIT_TARGETS.color) {
    const color = parseEmbedColor(values["color"] ?? "");

    if (color === null) {
      delete next.color;
    } else {
      next.color = color;
    }

    return next;
  }

  const urlKey = EMBED_EDIT_TARGET_URLS[target];
  const url = cleanUrl(values["url"]);

  if (url) next[urlKey] = url;
  else delete next[urlKey];

  return next;
}

/**
 * The refusal a member gets when the draft has expired.
 */
export const EXPIRED_DRAFT_MESSAGE =
  "This draft has expired. Please run the command again.";

/**
 * The embed designer.
 *
 * Owns the token store that holds the template being edited, builds the
 * panel that shows it, and answers the three components the panel
 * carries: the select that opens the modals, the modals themselves, and
 * the button that saves the design.
 */
export class EmbedDesigner {
  private readonly store = new TokenStore<EmbedDraft>();

  /**
   * The prefix the designer's custom ids carry.
   *
   * One designer owns one id space. An area that wants its own builds
   * its own designer and registers that one instead.
   */
  readonly prefix: string;

  constructor(prefix = EMBED_DESIGNER_PREFIX) {
    this.prefix = prefix;
  }

  /**
   * Starts a design session.
   *
   * The draft is made; the panel is not shown. A caller that renders
   * the panel itself uses this, and the re-render after an edit lands on
   * the message the modal was opened from.
   *
   * @param template the template the draft starts from.
   * @param ownerId  the member who starts it. Only that member may drive
   *                 the draft — the select that opens the modals carries
   *                 the token, and the token is in the message.
   * @param onSave   what to do when the design is saved. Without one the
   *                 panel carries no save button.
   * @returns the token that goes into the custom ids.
   */
  start(
    template: EmbedTemplate,
    ownerId: string,
    onSave?: EmbedSaveHandler,
  ): string {
    return this.store.issue({
      template: { ...template },
      ownerId,
      panel: null,
      onSave: onSave ?? null,
    });
  }

  /**
   * Starts a design session and shows its panel.
   *
   * This is the whole flow in one call: the draft is made, the panel is
   * posted, and the handle to the panel is kept in the draft. The
   * re-render after an edit therefore lands on the message that
   * actually carries the panel — the reply, or the follow-up the panel
   * was sent as.
   *
   * @returns the token that goes into the custom ids.
   */
  async open(
    interaction: RepliableInteraction,
    options: EmbedOpenOptions,
  ): Promise<string> {
    const token = this.start(
      options.template,
      options.ownerId,
      options.onSave,
    );

    const handle = await respond(interaction, this.buildPanel(token));
    const draft = this.draft(token);

    if (draft) {
      this.store.set(token, { ...draft, panel: handle });
    }

    return token;
  }

  /**
   * The draft behind a token.
   *
   * @returns the draft, or `undefined` when the token has expired.
   */
  draft(token: string): EmbedDraft | undefined {
    return this.store.get(token);
  }

  /**
   * Reads the template behind a token.
   */
  read(token: string): EmbedTemplate | undefined {
    return this.store.get(token)?.template;
  }

  /**
   * Who started the draft.
   *
   * @returns the member's id, or `undefined` when the token has expired.
   */
  ownerOf(token: string): string | undefined {
    return this.store.get(token)?.ownerId;
  }

  /**
   * Is this member the draft's owner?
   *
   * The check an area makes before it lets an interaction near the
   * draft. It is a plain question, with no side effect: a handler that
   * wants to refuse in its own words asks this and answers for itself.
   */
  isOwner(token: string, userId: string): boolean {
    return this.store.get(token)?.ownerId === userId;
  }

  /**
   * Refuses an interaction that is not the draft owner's.
   *
   * The one call an area needs: the handler asks, and either goes on or
   * has already been told no.
   *
   * @returns `true` when the caller owns the draft and may go on,
   *          `false` when the interaction was refused. The refusal has
   *          been sent by the time this returns.
   */
  async guardOwner(
    interaction: RepliableInteraction,
    token: string,
  ): Promise<boolean> {
    const ownerId = this.ownerOf(token);

    if (!ownerId) {
      await replyError(interaction, EXPIRED_DRAFT_MESSAGE, { ephemeral: true });

      return false;
    }

    if (ownerId !== interaction.user.id) {
      await replyError(interaction, OWNER_DENIAL_MESSAGE, { ephemeral: true });

      return false;
    }

    return true;
  }

  /**
   * The select menu that drives the designer.
   *
   * @param token the draft the menu drives. It travels in the custom id.
   */
  buildOptions(token: string): StringSelectMenuBuilder {
    return buildEmbedDesignerOptions(token, this.prefix);
  }

  /**
   * The modal for one edit target.
   */
  buildModal(target: EmbedEditTarget, token: string): ModalBuilder {
    const template = this.read(token) ?? {};

    return buildEmbedDesignerModal(target, template, token, this.prefix);
  }

  /**
   * The panel: the embed being edited, the select menu, and the save
   * button.
   *
   * The save button is only there when the draft has something to save.
   */
  buildPanel(token: string): ReplyPayload {
    const draft = this.draft(token);
    const template = draft?.template ?? {};

    const rows = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        this.buildOptions(token),
      ),
      ...(draft?.onSave
        ? [
            // The one main action of the panel, alone on its row.
            actionRow(
              primaryButton({
                customId: embedDesignerSaveCustomId(token, this.prefix),
                label: "Save",
              }),
            ),
          ]
        : []),
    ];

    return {
      embeds: [embedTemplateToBuilder(template)],
      components: rows,
    };
  }

  /**
   * Re-renders the panel.
   *
   * The edit lands on the message that actually carries the panel: the
   * handle the draft was opened with, or — for a draft whose panel the
   * caller renders itself — the message the modal was opened from.
   *
   * The acknowledgement comes first: Discord gives a modal submit three
   * seconds, and the re-render can take as long as it needs. The
   * dispatcher defers every modal submit with an ephemeral reply, so
   * that placeholder is resolved with a short confirmation — leaving it
   * pending would leave the member looking at a spinner.
   */
  async renderPanel(
    interaction: ModalSubmitInteraction,
    token: string,
  ): Promise<void> {
    const draft = this.draft(token);

    if (!draft) return;

    const payload = this.buildPanel(token);
    const message = interaction.message;
    const hasPanel = draft.panel !== null || message !== null;

    if (!interaction.replied) {
      if (interaction.deferred) {
        await replySuccess(interaction, "Your design has been updated.");
      } else if (hasPanel) {
        // Nothing has answered the interaction yet, so the edit of the
        // panel is the acknowledgement.
        await interaction.deferUpdate().catch(() => undefined);
      }
    }

    if (draft.panel) {
      await draft.panel.edit(payload);

      return;
    }

    if (message) {
      await message.edit(payload);

      return;
    }

    // There is no panel to re-render, so the interaction's own reply is
    // the last place the design can go.
    await interaction.editReply(payload).catch(() => undefined);
  }

  /**
   * Applies a modal submission to the stored template.
   *
   * A modal can only be submitted by the member who opened it, so the
   * owner of the draft is the only person who can reach this.
   *
   * @returns the new template, or `null` when the token has expired.
   */
  apply(
    target: EmbedEditTarget,
    token: string,
    values: Readonly<Record<string, string>>,
  ): EmbedTemplate | null {
    const draft = this.store.get(token);

    if (!draft) return null;

    const next = applyEmbedEdit(target, draft.template, values);

    this.store.set(token, { ...draft, template: next });

    return next;
  }

  /**
   * Stops the token store's sweep timer.
   */
  stop(): void {
    this.store.stop();
  }
}

/* ------------------------------------------------------------------ *
 * The router handlers
 * ------------------------------------------------------------------ */

/**
 * The designer that owns a prefix.
 *
 * @returns the designer, or `null` when there is none — the interaction
 *          has been refused by then.
 */
async function designerFor(
  prefix: string,
  interaction: RepliableInteraction,
  kind: string,
): Promise<EmbedDesigner | null> {
  const designer = registeredDesigners.get(prefix);

  if (designer) return designer;

  logger.error(
    `[EmbedDesigner] No designer is registered for the prefix "${prefix}".`,
  );

  await refuseInactive(
    interaction,
    `That ${kind} is no longer active. Please run the command again.`,
  );

  return null;
}

/**
 * Answers a press of the select menu.
 *
 * The select is the exposed part of the designer: its custom id carries
 * the draft's token, and the token is in a message the whole channel
 * can read. So the owner check happens here, before the modal opens —
 * a member who does not own the draft gets nothing but a refusal.
 */
async function handleDesignerSelect(
  prefix: string,
  interaction: AnySelectMenuInteraction,
  payload: string | null,
): Promise<void> {
  const designer = await designerFor(prefix, interaction, "menu");

  if (!designer) return;

  const token = tokenOf(payload, EMBED_DESIGNER_SELECT_ACTION);

  if (!token) {
    await refuseInactive(
      interaction,
      "That menu is no longer active. Please run the command again.",
    );

    return;
  }

  if (!(await designer.guardOwner(interaction, token))) return;

  const target = editTargetOf(interaction.values[0]);

  if (!target) {
    await refuseInactive(
      interaction,
      "That option is no longer active. Please run the command again.",
    );

    return;
  }

  await interaction.showModal(designer.buildModal(target, token));
}

/**
 * Answers a submitted modal.
 *
 * A modal is shown to one member and only that member can submit it, so
 * there is no owner check here: the select that opened the modal did
 * that.
 */
async function handleDesignerModal(
  prefix: string,
  interaction: ModalSubmitInteraction,
  payload: string | null,
): Promise<void> {
  const designer = await designerFor(prefix, interaction, "form");

  if (!designer) return;

  const [action, token] = splitAction(payload);

  if (!action || !token || !isEditTarget(action)) {
    await refuseInactive(
      interaction,
      "That form is no longer active. Please run the command again.",
    );

    return;
  }

  const next = designer.apply(
    action,
    token,
    readModalValues(interaction, action),
  );

  if (!next) {
    // The draft is gone: it expired, or the bot restarted.
    await replyError(interaction, EXPIRED_DRAFT_MESSAGE, { ephemeral: true });

    return;
  }

  await designer.renderPanel(interaction, token);
}

/**
 * Answers a press of the save button.
 *
 * The button is on the panel, in a channel other people can read, so it
 * is exposed exactly as the select is and the owner check happens here
 * too.
 */
async function handleDesignerButton(
  prefix: string,
  interaction: ButtonInteraction,
  payload: string | null,
): Promise<void> {
  const designer = await designerFor(prefix, interaction, "button");

  if (!designer) return;

  const token = tokenOf(payload, EMBED_DESIGNER_SAVE_ACTION);

  if (!token) {
    await refuseInactive(
      interaction,
      "That button is no longer active. Please run the command again.",
    );

    return;
  }

  if (!(await designer.guardOwner(interaction, token))) return;

  const draft = designer.draft(token);

  if (!draft?.onSave) {
    await refuseInactive(
      interaction,
      "That button is no longer active. Please run the command again.",
    );

    return;
  }

  try {
    await draft.onSave(draft.template, interaction);
  } catch (error) {
    logger.error("[EmbedDesigner] The design could not be saved.", error);

    await replyError(
      interaction,
      "Something went wrong and your design was not saved.",
      { ephemeral: true },
    );

    return;
  }

  // The area may have said what it saved. When it has not, the designer
  // says it.
  if (!interaction.replied && !interaction.deferred) {
    await replySuccess(interaction, "Your design has been saved.", {
      ephemeral: true,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Reading the ids
 * ------------------------------------------------------------------ */

/**
 * The token in a payload, when the payload is the action being answered.
 *
 * @returns the token, or `null` when the payload is not that action's.
 */
function tokenOf(payload: string | null, action: string): string | null {
  if (!payload) return null;

  const parts = payload.split(":");

  if (parts[0] !== action) return null;

  const token = parts.slice(1).join(":");

  return token === "" ? null : token;
}

/**
 * Splits a payload into its action and the rest.
 */
function splitAction(payload: string | null): [string | null, string | null] {
  if (!payload) return [null, null];

  const parts = payload.split(":");
  const action = parts[0] ?? null;
  const rest = parts.slice(1).join(":");

  return [action, rest === "" ? null : rest];
}

/**
 * Is this one of the five edit targets?
 */
function isEditTarget(value: string): value is EmbedEditTarget {
  return EMBED_EDIT_TARGET_VALUES.includes(value);
}

/**
 * The edit target a select menu was answered with.
 */
function editTargetOf(value: string | undefined): EmbedEditTarget | null {
  if (value === undefined) return null;

  return isEditTarget(value) ? value : null;
}

/**
 * The values a submitted modal carried.
 *
 * Only the fields of that target are read: the modal was built by the
 * designer, so the others are not there.
 */
function readModalValues(
  interaction: ModalSubmitInteraction,
  target: EmbedEditTarget,
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const field of EMBED_EDIT_TARGET_FIELDS[target]) {
    values[field] = readTextInput(interaction, field);
  }

  return values;
}

/**
 * The value of one of the modal's text inputs.
 *
 * A field that is not there is a value of nothing rather than a crash:
 * the edit is applied to what the modal did carry.
 */
function readTextInput(
  interaction: ModalSubmitInteraction,
  id: string,
): string {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return "";
  }
}

/**
 * Refuses an interaction the designer no longer answers.
 */
async function refuseInactive(
  interaction: RepliableInteraction,
  message: string,
): Promise<void> {
  await replyError(interaction, message, { ephemeral: true });
}

/* ------------------------------------------------------------------ *
 * The registration
 * ------------------------------------------------------------------ */

/**
 * The designers that are registered, by prefix.
 *
 * The router handler resolves the designer through this map rather than
 * closing over an instance, so a designer that is rebuilt does not leave
 * the older panel talking to a dead object: the older draft is gone, and
 * the panel says so.
 */
const registeredDesigners = new Map<string, EmbedDesigner>();

/**
 * The designer core owns.
 *
 * One designer, one store of drafts, one `embeds` prefix.
 */
export const embedDesigner = new EmbedDesigner();

/**
 * Registers the designer's handlers with the router.
 *
 * **Idempotent.** The prefix is registered once, however many times this
 * is called: registering twice is a duplicate, and the router warns
 * about duplicates — a warning that fires on a normal path is a warning
 * nobody reads.
 *
 * @param designer the designer whose ids are registered. Defaults to the
 *                 one core owns.
 */
export function registerEmbedDesignerInteractions(
  designer: EmbedDesigner = embedDesigner,
): void {
  const prefix = designer.prefix;
  const registered = registeredPrefixes();

  if (!registered.buttons.includes(prefix)) {
    registerButton(prefix, async (interaction, payload) => {
      await handleDesignerButton(prefix, interaction, payload);
    });
  }

  if (!registered.selects.includes(prefix)) {
    registerSelect(prefix, async (interaction, payload) => {
      await handleDesignerSelect(prefix, interaction, payload);
    });
  }

  if (!registered.modals.includes(prefix)) {
    registerModal(prefix, async (interaction, payload) => {
      await handleDesignerModal(prefix, interaction, payload);
    });
  }

  registeredDesigners.set(prefix, designer);
}

// The designer is core's, so core wires it. Registering on import means
// an area that uses the designer does not have to know that the prefix
// needs registering — which is how the designer ended up dead.
registerEmbedDesignerInteractions();
