/**
 * The closed unions the schema encodes, and the helpers that turn them
 * into constraints.
 *
 * Every table under `db/schema/` is assembled from the column helpers in
 * `db/dialect.ts` and the unions below, so that a primary key is always a
 * uuid, a Discord id is always `text`, a timestamp is always an instant
 * and every table carries the same `id` / `created_at` / `updated_at`
 * trio. Changing a rule in one place changes it everywhere, which is the
 * point.
 *
 * The rules themselves are ratified in `docs/porting/schema.md`.
 *
 * **Nothing in this file knows which SQL engine is in use.** The column
 * types come from `db/dialect.ts`; the unions are plain data.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { check } from "../dialect.js";
import type { PortableColumn } from "../dialect.js";

/* ------------------------------------------------------------------ *
 * Closed unions
 *
 * Each list is the single source of truth for a state machine: the TS type
 * is derived from it, and the CHECK constraint is generated from it.
 * ------------------------------------------------------------------ */

/** D14 — a scrim slot's state. A free slot is a row, not an absence. */
export const SLOT_STATES = ["free", "claimed", "locked", "banned"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

/**
 * D26 — the scrim lifecycle.
 *
 * A scrim cannot be paused, so it has three states, not four.
 */
export const SCRIM_STATUSES = ["draft", "open", "closed"] as const;
export type ScrimStatus = (typeof SCRIM_STATUSES)[number];

/**
 * D26 — the tourney lifecycle.
 *
 * A tourney can be paused, which is a state a scrim cannot be in. Quotient
 * derived "open" and "closed" from `opened_at`/`closed_at` and could not
 * tell "paused" from "closed" at all.
 */
export const TOURNEY_STATUSES = ["draft", "open", "paused", "closed"] as const;
export type TourneyStatus = (typeof TOURNEY_STATUSES)[number];

/** D15 — the features a guild can be entitled to. */
export const ENTITLEMENT_FEATURES = [
  "scrim_slots",
  // The tournament equivalents of `scrim_slots`: the custom reaction
  // emojis, the registration "required lines", the duplicate-tag
  // allowance, and the tournament count limit. They are a separate
  // entitlement because scrims and tournaments are separate features —
  // one purchase of the other must not unlock these.
  "tourney_features",
  "slot_reminders",
  "idp_transfer",
  "extra_channels",
  "screenshot_types",
  "success_message",
] as const;
export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number];

/**
 * How an entitlement was granted.
 *
 * `premium` is bought, `owner` is handed out by the guild owner (the target
 * bot is single-guild, so this is the normal case), `manual` is a one-off
 * override by an administrator.
 */
export const ENTITLEMENT_SOURCES = ["premium", "owner", "manual"] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** D37 — the premium purchase state machine. `failed` is retryable. */
export const PREMIUM_TRANSACTION_STATUSES = [
  "pending",
  "paid",
  "failed",
] as const;
export type PremiumTransactionStatus =
  (typeof PREMIUM_TRANSACTION_STATUSES)[number];

/**
 * The screenshot flavours the SS verification flow understands.
 *
 * `any_ss`, not `"Any SS"` — a space and mixed case in a database value is a
 * trap, and nothing external depends on the literal (D37).
 */
export const SCREENSHOT_TYPES = [
  "youtube",
  "instagram",
  "rooter",
  "loco",
  "any_ss",
  "custom",
] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];

/** What a scrim's autoclean pass removes when the match ends. */
export const AUTOCLEAN_KINDS = ["channel", "role"] as const;
export type AutocleanKind = (typeof AUTOCLEAN_KINDS)[number];

/** The days a scrim may be opened on. */
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The scope of a lockdown record. */
export const LOCKDOWN_TYPES = [
  "channel",
  "guild",
  "category",
  "maintenance",
] as const;
export type LockdownType = (typeof LOCKDOWN_TYPES)[number];

/**
 * What a block-list entry refers to.
 *
 * The values are `"1"` (a user) and `"2"` (a guild). They are stored as text
 * because every enum-ish column in this schema is text with a CHECK, and
 * because Quotient's own `block_id_type` was a string of digits.
 */
export const BLOCK_ID_TYPES = ["1", "2"] as const;
export type BlockIdType = (typeof BLOCK_ID_TYPES)[number];

/**
 * The kinds of member an auto-role list applies to.
 *
 * The source stored two columns (`humans`, `bots`); the join table stores
 * one `kind` column instead, so adding a kind is a one-word change.
 */
export const AUTOROLE_KINDS = ["human", "bot"] as const;
export type AutoroleKind = (typeof AUTOROLE_KINDS)[number];

/**
 * The event names the durable scheduler understands.
 *
 * `jobs.event` names the handler that fires when the row comes due, so the
 * set is closed: an unknown event would sit in the table forever.
 */
export const JOB_EVENTS = [
  "reminder",
  "msg_delete",
  "scrim_open",
  "autoclean",
  "scrim_match",
  "scrim_ban",
  "scrim_reserve",
  "lockdown",
  "user_premium",
  "guild_premium",
  "vote",
  "alert",
  "autopurge",
  // The community area's daily maintenance pass: the command-usage
  // retention prune, and anything else that runs once a day.
  "community_daily",
  // The tournament's daily registration-open.
  "tourney_open",
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/* ------------------------------------------------------------------ *
 * Constraints
 * ------------------------------------------------------------------ */

/**
 * A `column IN (...)` check constraint.
 *
 * The allowed values have to be inlined as literals — a bind parameter is
 * not allowed inside a CHECK expression. They come from the closed unions
 * declared in this file — never from user input — and the quoting is
 * escaped anyway so that the helper stays safe if that ever changes.
 */
export function oneOfCheck(
  name: string,
  column: PortableColumn,
  allowed: readonly string[],
): SQL {
  const list = allowed
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");

  return check(name, sql`${column} in (${sql.raw(list)})`);
}
