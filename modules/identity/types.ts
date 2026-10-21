/**
 * The domain types of the identity area.
 *
 * Tag check, easy tag and screenshot verification. Everything here is a
 * closed union or a plain data shape.
 *
 * Two rules the types enforce:
 *
 *  - **A Discord id is a string.** Snowflakes exceed `Number.MAX_SAFE_INTEGER`
 *    (S2), so they are never parsed into numbers.
 *  - **A screenshot type is the schema's list.** `ScreenshotType` is
 *    re-exported from `db/schema.ts`, so the union in TypeScript and the
 *    `CHECK` constraint in Postgres are the same list, written once. Note
 *    that the value is `any_ss` and not `"Any SS"` — a space and mixed case
 *    in a database value is a trap (S5).
 */

import type { ScreenshotType } from "../../db/schema.js";

export type { ScreenshotType };

/* ------------------------------------------------------------------ *
 * Tag check
 * ------------------------------------------------------------------ */

/**
 * A channel where a captain has to mention their teammates.
 *
 * `ignoreRoleId` is the guild's ignore role — the role a member holds to opt
 * out of the check. It is stored **by id** (D16); Quotient looked it up by
 * the name `quotient-tag-ignore` on every single message.
 */
export interface TagCheckConfig {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  /** How many teammates the captain has to mention. */
  readonly requiredMentions: number;
  /** Delete the offending message after a while. */
  readonly deleteAfter: boolean;
  /** The role that opts a member out of the check. */
  readonly ignoreRoleId: string | null;
}

/* ------------------------------------------------------------------ *
 * Easy tag
 * ------------------------------------------------------------------ */

/** A channel where raw ids and `@names` are turned into real mentions. */
export interface EasyTagConfig {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  /** Delete the message (and the bot's answer) after a while. */
  readonly deleteAfter: boolean;
  /** The role that opts a member out of the conversion. */
  readonly ignoreRoleId: string | null;
}

/* ------------------------------------------------------------------ *
 * Screenshot verification
 * ------------------------------------------------------------------ */

/**
 * One screenshot-verification setup.
 *
 * `channelId` is the channel the screenshots are posted in, `roleId` is the
 * role the bot grants once enough screenshots are accepted. Both are ids
 * (D16).
 */
export interface SsConfig {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly roleId: string;
  /** How many screenshots the member has to submit. */
  readonly requiredSs: number;
  /** The page or channel the screenshot has to belong to. */
  readonly channelName: string;
  /** The link to that page or channel. */
  readonly channelLink: string;
  /** The words a custom filter matches on. The first one is the name. */
  readonly keywords: readonly string[];
  /** Whether the same screenshot may be submitted twice. */
  readonly allowSame: boolean;
  readonly ssType: ScreenshotType;
  /** The message shown when the verification succeeds. */
  readonly successMessage: string | null;
}

/** One submitted screenshot. */
export interface SsSubmission {
  readonly id: string;
  readonly ssConfigId: string;
  readonly authorId: string;
  readonly channelId: string;
  readonly messageId: string;
  /** 16 hex characters of dHash. `null` when the provider produced none. */
  readonly dhash: string | null;
  /** 16 hex characters of pHash. */
  readonly phash: string | null;
  readonly createdAt: Date;
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/** How each screenshot type is called in a message. */
export const SCREENSHOT_TYPE_LABELS: Readonly<Record<ScreenshotType, string>> = {
  youtube: "YouTube",
  instagram: "Instagram",
  rooter: "Rooter",
  loco: "Loco",
  any_ss: "Any Screenshot",
  custom: "Custom",
};

/**
 * The screenshot types a guild may pick without a premium entitlement.
 *
 * Quotient's screenshot-type selector marked everything but YouTube as
 * "Premium only" and the button handler refused the premium ones, so
 * YouTube is the only free flavour. The gate is `screenshot_types`
 * (D15); see `modules/identity/service.ts`.
 */
export const FREE_SCREENSHOT_TYPES: readonly ScreenshotType[] = ["youtube"];

/**
 * Is this type behind the `screenshot_types` entitlement?
 */
export function isPremiumScreenshotType(type: ScreenshotType): boolean {
  return !FREE_SCREENSHOT_TYPES.includes(type);
}

/**
 * The name of the role that opts a member out of the tag checks.
 *
 * Quotient created a guild role with this name so a member could stop the
 * bot from touching their messages. The id is stored on the configuration
 * row (D16); the name is only ever used to **create** the role.
 */
export const TAG_IGNORE_ROLE_NAME = "quotient-tag-ignore";
