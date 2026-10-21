/**
 * Shared column builders and the closed unions the schema encodes.
 *
 * Every table under `db/schema/` is assembled from these helpers, so that a
 * primary key is always a uuid, a Discord id is always `text`, a timestamp
 * is always `timestamptz`, and every table carries the same
 * `id` / `created_at` / `updated_at` trio. Changing a rule here changes it
 * everywhere, which is the point.
 *
 * The rules themselves are ratified in `docs/porting/schema.md`.
 */

import type { AnyColumn } from "drizzle-orm/column";
import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { CheckBuilder } from "drizzle-orm/pg-core";

/**
 * A Discord snowflake.
 *
 * Snowflakes are 64-bit and a JS number only holds integers exactly up to
 * 2^53, so a `bigint` column would round ids on the way into the process and
 * two different users could end up with the same id. Text is the only
 * lossless option in JS, and Postgres compares text ids perfectly well.
 */
export function discordId(name: string) {
  return text(name);
}

/**
 * A list of Discord snowflakes.
 *
 * `text[]`, never `bigint[]`, for the same precision reason as {@link discordId}.
 */
export function discordIdArray(name: string) {
  return text(name).array();
}

/**
 * The primary key every table gets.
 *
 * `uuid` with `default gen_random_uuid()`. Postgres 16 has the function
 * built in, so no extension is needed.
 *
 * **Why uuid and not a serial:** ids travel. They appear in Discord
 * `custom_id`s, in `jobs.payload` JSON, and in every future API payload. A
 * uniform opaque string removes the int-versus-string ambiguity at exactly
 * those boundaries, and one strategy means nobody has to remember which
 * table used which.
 *
 * The one exception is {@link serialId}.
 */
export function primaryId(name = "id") {
  return uuid(name).primaryKey().defaultRandom();
}

/**
 * A foreign key that points at a {@link primaryId}.
 *
 * Kept as a helper so a uuid reference can never drift into an `integer`
 * column by accident — Postgres would reject the FK, but the error would
 * arrive at migration time rather than at review time.
 */
export function foreignId(name: string) {
  return uuid(name);
}

/**
 * The one serial primary key in the schema.
 *
 * `command_usage` gets a `bigserial` because it is the only high-write
 * table — one row per command invocation — and its id is never referenced
 * from anywhere else. A uuid v4 generation plus a 16-byte index entry on
 * the hottest write path in the database is a cost with no benefit.
 */
export function serialId(name = "id") {
  return bigserial(name, { mode: "number" }).primaryKey();
}

/**
 * Row creation time.
 *
 * `timestamptz` (D30): the database stores an instant, and the IST offset is
 * applied only when something is rendered for a human.
 */
export function createdAt(name = "created_at") {
  return timestamp(name, { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();
}

/**
 * Row modification time.
 *
 * `$onUpdate` is a drizzle-side hook, so it only fires on writes that go
 * through drizzle. A hand-written `UPDATE` has to set `updated_at` itself.
 */
export function updatedAt(name = "updated_at") {
  return timestamp(name, { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

/**
 * A `column IN (...)` check constraint.
 *
 * Postgres refuses bind parameters inside a CHECK expression, so the allowed
 * values have to be inlined as literals. They come from the closed unions
 * declared in this file — never from user input — and the quoting is escaped
 * anyway so that the helper stays safe if that ever changes.
 */
export function oneOfCheck(
  name: string,
  column: AnyColumn,
  allowed: readonly string[],
): CheckBuilder {
  const list = allowed
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");

  return check(name, sql`${column} in (${sql.raw(list)})`);
}

/**
 * A containment check on an array column: every element must be in the
 * allowed set.
 *
 * `open_days <@ ARRAY['monday', ...]::text[]` — "open_days is contained by
 * the weekday set". An empty array satisfies it, which is what we want: no
 * open days means no restriction, not a broken row.
 */
export function arrayContainedInCheck(
  name: string,
  column: AnyColumn,
  allowed: readonly string[],
): CheckBuilder {
  const list = allowed
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");

  return check(name, sql`${column} <@ ARRAY[${sql.raw(list)}]::text[]`);
}

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
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];
