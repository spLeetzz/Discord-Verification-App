/**
 * Message templates and the `<<keyword>>` substitution set.
 *
 * D32: Quotient stored `discord.Embed.to_dict()` as a **Python literal
 * string** and re-parsed it with `ast.literal_eval` on every render. Any
 * template written by another code path crashed the next render. Ours is
 * `jsonb` holding a typed {@link EmbedTemplate}, rendered by one function.
 *
 * The `<<keyword>>` set is ported as-is:
 *
 *  - open message: `<<mentions>>` `<<slots>>` `<<reserved>>` `<<slotlist>>`
 *    `<<multireg>>` `<<teamname>>` (and the source's two mention lists);
 *  - close message: `<<slots>>` `<<filled>>` `<<time_taken>>` `<<open_time>>`;
 *  - slotlist: `<<name>>` `<<time_taken>>` `<<open_time>>` `<<slots>>`.
 *
 * This module is pure: no database, no Discord. That is what makes the
 * substitution testable.
 */

/** One field of an embed template. */
export interface EmbedTemplateField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

/**
 * The shape of a stored embed template.
 *
 * It is deliberately the subset of an embed that a template needs. The
 * column is a JSON document, so the shape is not database-enforced —
 * this type is the contract, and `parseTemplate` is the only way a
 * template enters the process.
 *
 * A **type alias**, not an interface: the column is
 * `jsonCol<Record<string, unknown>>`, and only an object type — an
 * interface has no implicit index signature — can be written to one.
 */
export type EmbedTemplate = {
  readonly title?: string;
  readonly description?: string;
  readonly color?: number;
  readonly fields?: readonly EmbedTemplateField[];
  readonly footer?: { readonly text?: string; readonly icon_url?: string };
  readonly image?: { readonly url?: string };
  readonly author?: {
    readonly name?: string;
    readonly icon_url?: string;
    readonly url?: string;
  };
};

/**
 * Reads a stored template value.
 *
 * A malformed value must not crash a render (D32's whole point), so
 * anything unrecognisable becomes an empty template and the caller falls
 * back to the default message.
 */
export function parseTemplate(value: unknown): EmbedTemplate {
  if (typeof value !== "object" || value === null) return {};

  const source = value as Record<string, unknown>;

  const template: {
    title?: string;
    description?: string;
    color?: number;
    fields?: EmbedTemplateField[];
    footer?: { text?: string; icon_url?: string };
    image?: { url?: string };
    author?: { name?: string; icon_url?: string; url?: string };
  } = {};

  if (typeof source.title === "string") template.title = source.title;
  if (typeof source.description === "string") {
    template.description = source.description;
  }
  if (typeof source.color === "number") template.color = source.color;

  if (Array.isArray(source.fields)) {
    const fields: EmbedTemplateField[] = [];

    for (const raw of source.fields) {
      if (typeof raw !== "object" || raw === null) continue;

      const field = raw as Record<string, unknown>;

      if (typeof field.name !== "string") continue;
      if (typeof field.value !== "string") continue;

      fields.push({
        name: field.name,
        value: field.value,
        ...(typeof field.inline === "boolean" ? { inline: field.inline } : {}),
      });
    }

    if (fields.length > 0) template.fields = fields;
  }

  if (typeof source.footer === "object" && source.footer !== null) {
    const footer = source.footer as Record<string, unknown>;

    if (typeof footer.text === "string" || typeof footer.icon_url === "string") {
      template.footer = {
        ...(typeof footer.text === "string" ? { text: footer.text } : {}),
        ...(typeof footer.icon_url === "string"
          ? { icon_url: footer.icon_url }
          : {}),
      };
    }
  }

  if (typeof source.image === "object" && source.image !== null) {
    const image = source.image as Record<string, unknown>;

    if (typeof image.url === "string") template.image = { url: image.url };
  }

  if (typeof source.author === "object" && source.author !== null) {
    const author = source.author as Record<string, unknown>;

    if (
      typeof author.name === "string" ||
      typeof author.icon_url === "string" ||
      typeof author.url === "string"
    ) {
      template.author = {
        ...(typeof author.name === "string" ? { name: author.name } : {}),
        ...(typeof author.icon_url === "string"
          ? { icon_url: author.icon_url }
          : {}),
        ...(typeof author.url === "string" ? { url: author.url } : {}),
      };
    }
  }

  return template;
}

/**
 * Is a template empty enough that the caller should use the default?
 *
 * The source asked `len(template) <= 1`. That was a proxy for "the
 * template holds no content", and it worked because discord.py's
 * `Embed.to_dict()` always carried a `type: 'rich'` key — a designed
 * template could never have fewer than two keys.
 *
 * Ours is `jsonb` and does not carry that key, so the count would be a
 * trap: a template with a title and nothing else would be thrown away.
 * The question is therefore asked directly.
 */
export function isEmptyTemplate(template: EmbedTemplate): boolean {
  if (template.title !== undefined && template.title.length > 0) return false;

  if (
    template.description !== undefined &&
    template.description.length > 0
  ) {
    return false;
  }

  if ((template.fields?.length ?? 0) > 0) return false;

  if (
    template.footer?.text !== undefined &&
    template.footer.text.length > 0
  ) {
    return false;
  }

  if (template.image?.url !== undefined) return false;

  if (template.author?.name !== undefined) return false;

  return true;
}

/**
 * The keywords the open message understands.
 *
 * The six D32 names come first; the source's two mention lists follow,
 * because they are part of "as-is" and cost nothing.
 */
export const OPEN_MESSAGE_KEYWORDS = [
  "mentions",
  "slots",
  "reserved",
  "slotlist",
  "multireg",
  "teamname",
  "mention_banned",
  "mention_reserved",
] as const;

/** The keywords the close message understands. */
export const CLOSE_MESSAGE_KEYWORDS = [
  "slots",
  "filled",
  "time_taken",
  "open_time",
] as const;

/** The keywords the slotlist understands. */
export const SLOTLIST_KEYWORDS = [
  "name",
  "time_taken",
  "open_time",
  "slots",
] as const;

/** A keyword and the value it is replaced with. */
export type KeywordValues = Readonly<Record<string, string>>;

/**
 * Replaces every `<<keyword>>` in a string.
 *
 * The source replaced keywords across the *whole serialised embed*, so a
 * keyword in a field name or in the footer was replaced too. This does the
 * same: the substitution runs over every text the template holds.
 *
 * A keyword with no value is left alone rather than replaced with an
 * empty string — a template that mentions `<<slotlist>>` and does not get
 * a value should still show the keyword, so the mistake is visible.
 */
export function substituteKeywords(
  text: string,
  values: KeywordValues,
): string {
  let result = text;

  for (const [keyword, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;

    result = result.replaceAll(`<<${keyword}>>`, value);
  }

  return result;
}

/**
 * Applies the substitution to every text a template holds.
 *
 * The returned template is a plain object, ready to be stored as `jsonb`
 * or rendered.
 */
export function applyKeywords(
  template: EmbedTemplate,
  values: KeywordValues,
): EmbedTemplate {
  const sub = (text: string): string => substituteKeywords(text, values);

  return {
    ...(template.title !== undefined ? { title: sub(template.title) } : {}),
    ...(template.description !== undefined
      ? { description: sub(template.description) }
      : {}),
    ...(template.fields !== undefined
      ? {
          fields: template.fields.map((field) => ({
            name: sub(field.name),
            value: sub(field.value),
            ...(field.inline !== undefined ? { inline: field.inline } : {}),
          })),
        }
      : {}),
    ...(template.footer !== undefined
      ? {
          footer: {
            ...(template.footer.text !== undefined
              ? { text: sub(template.footer.text) }
              : {}),
            ...(template.footer.icon_url !== undefined
              ? { icon_url: template.footer.icon_url }
              : {}),
          },
        }
      : {}),
  };
}
