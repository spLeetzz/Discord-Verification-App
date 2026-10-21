/**
 * The premium entitlement seam.
 *
 * D15 replaces Quotient's single `Guild.is_premium` boolean with one row
 * per (guild, feature), and `assertEntitled(guildId, feature)` is the only
 * place a gate is read.
 *
 * `core/` cannot import from `db/` — the runtime layer must not depend on
 * the storage layer, or every test of a guard would need a database. So the
 * lookup is an *interface* here, and the premium engineer implements it
 * against the real tables.
 *
 * Two ways to wire it up:
 *
 * ```ts
 * // The premium module owns the implementation.
 * import { assertEntitled } from "../modules/premium/entitlements.js";
 *
 * const guard = premiumGuard(PremiumFeature.scrimSlots, {
 *   isEntitled: (guildId, feature) => assertEntitled(guildId, feature),
 * });
 * ```
 *
 * or, in a test, with a stub:
 *
 * ```ts
 * const guard = premiumGuard(PremiumFeature.scrimSlots, {
 *   isEntitled: async () => false,
 * });
 * ```
 */

import type { PremiumFeature } from "./constants.js";

export { PremiumFeature } from "./constants.js";

/**
 * How an entitlement was granted.
 *
 * `premium` is bought, `owner` is handed out by the guild owner, `manual`
 * is a one-off override by an administrator.
 */
export type EntitlementSource = "premium" | "owner" | "manual";

/** One entitlement row, as the gates see it. */
export interface Entitlement {
  /** The guild the entitlement belongs to. */
  readonly guildId: string;
  /** The feature it covers. */
  readonly feature: PremiumFeature;
  /** Whether the feature is currently switched on. */
  readonly enabled: boolean;
  /** When it runs out, or `null` when it never does. */
  readonly expiresAt: Date | null;
  /** How it was granted. */
  readonly source: EntitlementSource;
}

/**
 * The entitlement lookup the guards depend on.
 *
 * Only `isEntitled` is required: a guard needs a yes/no answer. The rest is
 * optional so an implementation can be as simple as a boolean read.
 */
export interface EntitlementLookup {
  /**
   * Is the guild entitled to the feature right now?
   *
   * "Right now" means the entitlement is enabled *and* has not expired. An
   * expired entitlement is inactive, not deleted (D15).
   */
  isEntitled(guildId: string, feature: PremiumFeature): Promise<boolean>;

  /**
   * The full entitlement row, when the implementation can produce one.
   *
   * Used for the messages that want to say *until when* the feature is
   * available rather than just that it is not.
   */
  getEntitlement?(
    guildId: string,
    feature: PremiumFeature,
  ): Promise<Entitlement | null>;
}

/**
 * The free-tier allowances (D45).
 *
 * One object, read by every count gate, so the perk table and the code
 * cannot disagree. A feature with no entry here is unlimited.
 *
 * These are the limits the *code* enforces, not the ones the old perk
 * table advertised — the two had drifted apart, and the code is the one
 * users actually hit.
 */
export const FREE_TIER = {
  /** Scrims a guild may have open at once. */
  scrims: 3,
  /** Tournaments a guild may have at once. */
  tourneys: 1,
  /** Tag-check channels a guild may have. */
  tagcheckChannels: 1,
  /** Easy-tag channels a guild may have. */
  easytagChannels: 1,
  /** Slot managers a guild may have. */
  slotManagers: 1,
  /** Screenshot-verification configs a guild may have. */
  ssverifyConfigs: 1,
  /** Media-partner entries a guild may have. */
  mediaPartners: 1,
  /** Auto-purge channels a guild may have. */
  autopurgeChannels: 1,
} as const;

/** The names of the allowances in {@link FREE_TIER}. */
export type FreeTierKey = keyof typeof FREE_TIER;

/**
 * Reads one allowance.
 *
 * @returns the limit, or `null` when the feature is unlimited.
 */
export function freeTierLimit(key: FreeTierKey): number | null {
  return FREE_TIER[key];
}
