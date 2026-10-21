/**
 * The lockdown state machine.
 *
 * A lockdown is a row in the `lockdowns` table. The row *is* the state:
 * there is no flag on the channel, so there is nothing to fall out of
 * sync with Discord.
 *
 * ```
 *            lock (guarded)
 *    ┌──────────────────────────────┐
 *    │            absent            │
 *    └──────────────────────────────┘
 *                 │            ▲
 *                 │            │ unlock (guarded) / expiry
 *                 ▼            │
 *    ┌──────────────────────────────┐
 *    │            locked            │
 *    └──────────────────────────────┘
 * ```
 *
 * The guards are:
 *
 *  - **lock** refuses when a lockdown with the same key already exists.
 *    The key is the kind of lockdown plus the subject it is about: the
 *    channel for a channel lockdown, the category for a category one, the
 *    role for a maintenance lockdown, the guild for a server lockdown.
 *  - **unlock** refuses when there is no lockdown to lift, and refuses
 *    when the channel is covered by a *different* lockdown (a server lock
 *    or a maintenance mode) — lifting half of that is not a thing the
 *    moderator asked for.
 *
 * The rules are pure. They take the rows and return a decision, so the
 * guards can be tested without a database and without Discord.
 */

import { formatRelativeTime } from "../../core/time.js";
import type { LockRecord, LockdownType } from "./types.js";

/** What a lock or an unlock is trying to do. */
export interface LockRequest {
  readonly type: LockdownType;
  readonly guildId: string;
  /** The channel of a channel lockdown, or the category of a category one. */
  readonly channelId: string | null;
  /** Every channel the action touches. */
  readonly channelIds: readonly string[];
  /** The role of a maintenance lockdown. */
  readonly roleId: string | null;
  readonly expireTime: Date | null;
  readonly authorId: string;
  /** The channel's name, for the refusal message. */
  readonly channelName?: string | null;
  /** The role's name, for the refusal message. */
  readonly roleName?: string | null;
}

/** The decision a guard makes. */
export type LockDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** The decision an unlock guard makes. */
export type UnlockDecision =
  | {
      readonly allowed: true;
      /** The lockdown being lifted, when there is one. */
      readonly record: LockRecord | null;
      /** Whether the recorded permission state should be restored. */
      readonly restore: boolean;
    }
  | { readonly allowed: false; readonly reason: string };

/**
 * The identity of a lockdown.
 *
 * Two lockdowns conflict when they have the same key: the same kind of
 * lockdown, about the same subject.
 *
 * The key is `<kind>:<subject>` — the same shape as the block list's key.
 * The kind is in it so that a channel id can never collide with a role
 * id, and the subject is the thing the lockdown is about:
 *
 *  - `channel:<channelId>` — one channel is write-locked
 *  - `category:<categoryId>` — a category is hidden
 *  - `maintenance:<roleId>` — a role is locked out of the server
 *  - `guild:<guildId>` — the whole server is locked
 *
 * **This string is what the `lockdowns.lock_key` column holds.** The
 * unique constraint on that column is what makes "one lockdown per
 * subject" a fact of the database rather than a fact of a read-then-write
 * check: two moderators who lock the same subject at the same time cannot
 * both get their way, because the second insert is refused.
 *
 * The ids are Discord snowflakes, which are unique across Discord, so the
 * key is unique across the table without the guild in it.
 */
export function lockKey(input: {
  readonly guildId: string;
  readonly type: LockdownType;
  readonly channelId: string | null;
  readonly roleId: string | null;
}): string {
  switch (input.type) {
    case "channel":
      return `channel:${input.channelId ?? ""}`;
    case "category":
      return `category:${input.channelId ?? ""}`;
    case "maintenance":
      return `maintenance:${input.roleId ?? ""}`;
    case "guild":
      return `guild:${input.guildId}`;
  }
}

/**
 * The message that says a lockdown is already in place.
 *
 * Quotient's wording, with the time left added when the lockdown has one.
 *
 * @param existing the lockdown that is already in place, or `null` when
 *        the row that won the race cannot be found any more.
 */
function alreadyLockedMessage(
  request: LockRequest,
  existing: LockRecord | null,
  now: number,
): string {
  const remaining =
    existing === null || existing.expireTime === null
      ? ""
      : ` It unlocks ${formatRelativeTime(existing.expireTime, {
          now: new Date(now),
        })}.`;

  switch (request.type) {
    case "channel":
      return `**${request.channelName ?? "That channel"}** is already locked.${remaining}`;
    case "guild":
      return `The server is already locked.${remaining}`;
    case "maintenance":
      return `The server is already under maintenance for **${request.roleName ?? "that role"}**.${remaining}`;
    case "category":
      return `That category is already hidden.${remaining}`;
  }
}

/**
 * The refusal a second lockdown of the same subject gets.
 *
 * Two things refuse it, and they say the same thing: the double-lock
 * guard, which reads the rows first, and the unique constraint on
 * `lockdowns.lock_key`, which refuses the insert itself. The guard is the
 * explanation; the constraint is the backstop.
 *
 * @param existing every lockdown the guild has now.
 */
export function alreadyLockedRefusal(
  request: LockRequest,
  existing: readonly LockRecord[],
  now: number = Date.now(),
): string {
  const key = lockKey(request);
  const clash = existing.find((record) => lockKey(record) === key) ?? null;

  return alreadyLockedMessage(request, clash, now);
}

/**
 * May this lockdown be created?
 *
 * @param existing every lockdown the guild currently has.
 */
export function evaluateLock(
  request: LockRequest,
  existing: readonly LockRecord[],
  now: number = Date.now(),
): LockDecision {
  const key = lockKey(request);
  const clash = existing.find((record) => lockKey(record) === key);

  if (!clash) return { allowed: true };

  return { allowed: false, reason: alreadyLockedMessage(request, clash, now) };
}

/**
 * The lockdown that covers a channel, when it is not the channel's own.
 *
 * A server lockdown, a maintenance mode and a hidden category all hide
 * channels that are not the subject of the lock.
 */
export function findCoveringLock(
  channelId: string,
  existing: readonly LockRecord[],
): LockRecord | null {
  return (
    existing.find(
      (record) =>
        record.type !== "channel" && record.channelIds.includes(channelId),
    ) ?? null
  );
}

/**
 * May this lockdown be lifted?
 *
 * @param existing every lockdown the guild currently has.
 */
export function evaluateUnlock(
  request: LockRequest,
  existing: readonly LockRecord[],
): UnlockDecision {
  const key = lockKey(request);
  const record = existing.find((row) => lockKey(row) === key) ?? null;

  if (request.type === "channel") {
    if (record) return { allowed: true, record, restore: true };

    const covering = findCoveringLock(request.channelId ?? "", existing);

    if (covering) {
      return {
        allowed: false,
        reason:
          covering.type === "guild"
            ? "That channel is locked as part of a server lockdown. Use `/unlock server` to lift it."
            : covering.type === "maintenance"
              ? "That channel is hidden by maintenance mode. Use `/maintenance off` to lift it."
              : "That channel is hidden by its category. Use `/category unhide` to lift it.",
      };
    }

    return {
      allowed: false,
      reason: "That channel is not locked, so there is nothing to unlock.",
    };
  }

  if (record) return { allowed: true, record, restore: true };

  switch (request.type) {
    case "guild":
      return { allowed: false, reason: "The server is not locked." };
    case "maintenance":
      return {
        allowed: false,
        reason: `The server is not under maintenance for **${request.roleName ?? "that role"}**.`,
      };
    case "category":
      // A category can be unhidden even when the bot has no record of
      // hiding it: the command is a positive action, not the lifting of a
      // lockdown, and there may be channels that were hidden by hand.
      return { allowed: true, record: null, restore: false };
  }
}
