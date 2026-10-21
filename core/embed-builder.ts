/**
 * The embed designer.
 *
 * Quotient's embed builder (`src/core/embeds.py`) is a select menu with
 * five options — the message itself, the thumbnail, the image, the footer
 * icon and the colour — and each option opens a modal.
 *
 * Two things are different here:
 *
 *  - The stored value is a **plain JSON object** (D32). Quotient stored
 *    `discord.Embed.to_dict()` as a Python literal string and re-parsed it
 *    with `ast.literal_eval` on every render, so a template written by
 *    another code path crashed the next render. This module stores JSON
 *    and parses it with `JSON.parse`.
 *  - The designer keeps its state in a token (D18). The template being
 *    edited has no database row yet — it is a wizard mid-flight — so the
 *    modal's custom id carries a token into an in-memory map.
 */

import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { TokenStore } from "./custom-id.js";
import { EMBED_COLOR } from "./constants.js";

/**
 * The prefix the designer's custom ids carry.
 */
export const EMBED_DESIGNER_PREFIX = "embeds";

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
 */
export function embedTemplateToBuilder(template: EmbedTemplate): EmbedBuilder {
  const embed = new EmbedBuilder();

  if (template.title) embed.setTitle(template.title);
  if (template.description) embed.setDescription(template.description);

  embed.setColor(template.color ?? EMBED_COLOR);

  if (template.thumbnailUrl) embed.setThumbnail(template.thumbnailUrl);
  if (template.imageUrl) embed.setImage(template.imageUrl);

  if (template.footerText || template.footerIconUrl) {
    embed.setFooter({
      text: template.footerText ?? "",
      iconURL: template.footerIconUrl,
    });
  }

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
 * The custom id of the select menu that drives the designer.
 */
export function embedDesignerSelectCustomId(prefix = EMBED_DESIGNER_PREFIX): string {
  return `${prefix}:options`;
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
 * Builds the select menu with the five edit targets.
 */
export function buildEmbedDesignerOptions(
  prefix = EMBED_DESIGNER_PREFIX,
): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(embedDesignerSelectCustomId(prefix))
    .setPlaceholder("Select an option to design the message.")
    .addOptions(
      {
        label: "Edit Message (Title, Description, Footer)",
        value: EMBED_EDIT_TARGETS.main,
        description: "Edit your embed title, description, and footer.",
        emoji: "📝",
      },
      {
        label: "Edit Thumbnail Image",
        value: EMBED_EDIT_TARGETS.thumbnail,
        description: "Small image on the right side of the embed.",
        emoji: "🖼️",
      },
      {
        label: "Edit Main Image",
        value: EMBED_EDIT_TARGETS.image,
        description: "Edit the embed's big image.",
        emoji: "🖼️",
      },
      {
        label: "Edit Footer Icon",
        value: EMBED_EDIT_TARGETS.footerIcon,
        description: "Small icon next to the footer message.",
        emoji: "🖌️",
      },
      {
        label: "Edit Embed Color",
        value: EMBED_EDIT_TARGETS.color,
        description: "Change the colour of the embed.",
        emoji: "🎨",
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
  const modal = new ModalBuilder()
    .setCustomId(embedDesignerModalCustomId(target, token, prefix))
    .setTitle(EMBED_EDIT_TARGET_TITLES[target]);

  if (target === EMBED_EDIT_TARGETS.main) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setPlaceholder("Enter text for the title of the embed here...")
          .setMaxLength(256)
          .setRequired(false)
          .setStyle(TextInputStyle.Short)
          .setValue(template.title ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description")
          .setPlaceholder("Enter text for the description of the embed here...")
          .setMaxLength(4000)
          .setRequired(false)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(template.description ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("footer")
          .setLabel("Footer Text")
          .setPlaceholder("Enter text for the footer of the embed here...")
          .setMaxLength(2048)
          .setRequired(false)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(template.footerText ?? ""),
      ),
    );

    return modal;
  }

  if (target === EMBED_EDIT_TARGETS.color) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("Enter a valid colour")
          .setPlaceholder("Examples: red, #00ffb3, 0,255,179")
          .setMaxLength(32)
          .setRequired(false)
          .setStyle(TextInputStyle.Short)
          .setValue(
            template.color === undefined
              ? ""
              : `#${template.color.toString(16).padStart(6, "0")}`,
          ),
      ),
    );

    return modal;
  }

  const urlKey = EMBED_EDIT_TARGET_URLS[target];

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("url")
        .setLabel("Enter Image URL (optional)")
        .setPlaceholder("Leave empty to remove it.")
        .setMaxLength(1024)
        .setRequired(false)
        .setStyle(TextInputStyle.Short)
        .setValue(template[urlKey] ?? ""),
    ),
  );

  return modal;
}

/** The title of the modal for each edit target. */
const EMBED_EDIT_TARGET_TITLES: Readonly<
  Record<(typeof EMBED_EDIT_TARGETS)[keyof typeof EMBED_EDIT_TARGETS], string>
> = {
  main: "Set Embed Message",
  thumb: "Edit Thumbnail Image",
  image: "Edit Main Image",
  footer_icon: "Edit Footer Icon",
  color: "Set Embed Color",
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
 * The embed designer.
 *
 * Owns the token store that holds the template being edited, and builds the
 * pieces the feature module wires into the router.
 */
export class EmbedDesigner {
  private readonly store = new TokenStore<EmbedTemplate>();
  private readonly prefix: string;

  constructor(prefix = EMBED_DESIGNER_PREFIX) {
    this.prefix = prefix;
  }

  /**
   * Starts a design session.
   *
   * @returns the token that goes into the modal's custom id.
   */
  start(template: EmbedTemplate): string {
    return this.store.issue({ ...template });
  }

  /**
   * Reads the template behind a token.
   */
  read(token: string): EmbedTemplate | undefined {
    return this.store.get(token);
  }

  /**
   * The select menu that drives the designer.
   */
  buildOptions(): StringSelectMenuBuilder {
    return buildEmbedDesignerOptions(this.prefix);
  }

  /**
   * The modal for one edit target.
   */
  buildModal(target: EmbedEditTarget, token: string): ModalBuilder {
    const template = this.read(token) ?? {};

    return buildEmbedDesignerModal(target, template, token, this.prefix);
  }

  /**
   * Applies a modal submission to the stored template.
   *
   * @returns the new template, or `null` when the token has expired.
   */
  apply(
    target: EmbedEditTarget,
    token: string,
    values: Readonly<Record<string, string>>,
  ): EmbedTemplate | null {
    const template = this.store.get(token);

    if (!template) return null;

    const next = applyEmbedEdit(target, template, values);

    this.store.set(token, next);

    return next;
  }

  /**
   * Stops the token store's sweep timer.
   */
  stop(): void {
    this.store.stop();
  }
}
