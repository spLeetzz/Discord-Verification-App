/**
 * The ban matrix.
 *
 * Quotient's `Scrim.ban_slot` (`src/models/esports/scrims.py:303-337`) had
 * four modes, hidden behind a four-button panel:
 *
 * ```python
 * to_ban, scrims = [slot.user_id], [self]
 * if ban_type == "2":   to_ban = slot.members
 * elif ban_type == "3": scrims = <every scrim in the guild>
 * elif ban_type == "4": to_ban = slot.members; scrims = <every scrim>
 * ```
 *
 * All four are kept, because they are a real user-facing matrix:
 *
 *  1. ban the team leader from this scrim;
 *  2. ban the whole team from this scrim;
 *  3. ban the team leader from every scrim in the server;
 *  4. ban the whole team from every scrim in the server.
 *
 * The plan is computed here, in a pure function, so the matrix can be
 * tested without a database.
 */

import { BanMode } from "./types.js";
import type { BanMode as BanModeType } from "./types.js";

/** The slot a ban is issued against. */
export interface BanTarget {
  /** The captain of the team. */
  readonly leaderId: string;
  /** The whole team, captain included. */
  readonly memberIds: readonly string[];
}

/** One user banned from one scrim. */
export interface BanEntry {
  readonly scrimId: string;
  readonly userId: string;
}

/** What a ban will do. */
export interface BanPlan {
  readonly entries: readonly BanEntry[];
  /** How many bans were skipped because the user was already banned. */
  readonly skipped: number;
}

/** How the plan is built. */
export interface PlanBanOptions {
  readonly mode: BanModeType;
  readonly target: BanTarget;
  /** The scrim the ban was issued from. */
  readonly thisScrimId: string;
  /** Every scrim in the guild, in `open_time` order. */
  readonly allScrimIds: readonly string[];
  /**
   * Is this user already banned from this scrim?
   *
   * The source skipped those, so a second ban did not stack a second row.
   * The `banned_teams` unique constraint on `(scrim_id, user_id)` makes
   * that idempotent at the database level too.
   */
  readonly isBanned?: (scrimId: string, userId: string) => boolean;
}

/**
 * The users a mode bans.
 *
 * Modes 2 and 4 ban the whole team — which in the source is
 * `slot.members`, and that array already contains the captain, because
 * the registration flow puts the author into it.
 */
export function bannedUsersForMode(
  mode: BanModeType,
  target: BanTarget,
): string[] {
  const members = target.memberIds.length > 0 ? target.memberIds : [target.leaderId];

  switch (mode) {
    case BanMode.leaderThisScrim:
    case BanMode.leaderAllScrims:
      return [target.leaderId];
    case BanMode.teamThisScrim:
    case BanMode.teamAllScrims:
      return [...members];
    default: {
      const exhaustive: never = mode;

      throw new Error(`unknown ban mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * The scrims a mode applies to.
 *
 * Modes 3 and 4 apply to every scrim in the guild; the source ordered
 * them by `open_time`.
 */
export function bannedScrimsForMode(
  mode: BanModeType,
  thisScrimId: string,
  allScrimIds: readonly string[],
): string[] {
  switch (mode) {
    case BanMode.leaderThisScrim:
    case BanMode.teamThisScrim:
      return [thisScrimId];
    case BanMode.leaderAllScrims:
    case BanMode.teamAllScrims:
      return allScrimIds.length > 0 ? [...allScrimIds] : [thisScrimId];
    default: {
      const exhaustive: never = mode;

      throw new Error(`unknown ban mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Works out what a ban will do.
 *
 * The entries are the (scrim, user) pairs to write. A user already
 * banned from a scrim is skipped, exactly as the source skipped them.
 */
export function planBan(options: PlanBanOptions): BanPlan {
  const users = bannedUsersForMode(options.mode, options.target);
  const scrims = bannedScrimsForMode(
    options.mode,
    options.thisScrimId,
    options.allScrimIds,
  );

  const entries: BanEntry[] = [];
  let skipped = 0;

  for (const userId of users) {
    for (const scrimId of scrims) {
      if (options.isBanned?.(scrimId, userId)) {
        skipped += 1;
        continue;
      }

      entries.push({ scrimId, userId });
    }
  }

  return { entries, skipped };
}

/**
 * Does a ban expire?
 *
 * A ban with a duration gets a `jobs` row so the unban happens even if
 * the bot restarts. A lifetime ban gets no job.
 */
export function banHasExpiry(expires: Date | null): boolean {
  return expires !== null;
}
