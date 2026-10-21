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
 * Every premium-gated thing a guild can hold (D45).
 *
 * This is the set of *features*, not the set of keys the limit table
 * happens to contain. The two are different sets: a feature the table
 * has no entry for is **unlimited**, and the type has to be able to say
 * so. Had the key type been derived from the table, "no entry" would
 * have been unrepresentable — every key would have carried a limit and
 * the unlimited branch of {@link freeTierLimit} would have been dead
 * code.
 *
 * The list is the per-guild things the entitlement gates cover. The
 * first eight are capped by the free tier; the rest are gated on the
 * entitlement alone, so there is no count to cap and the table has no
 * entry for them.
 */
export const FREE_TIER_FEATURES = [
  // The features the free tier caps.
  /** Scrims a guild may have open at once. */
  "scrims",
  /** Tournaments a guild may have at once. */
  "tourneys",
  /** Tag-check channels a guild may have. */
  "tagcheckChannels",
  /** Easy-tag channels a guild may have. */
  "easytagChannels",
  /** Slot managers a guild may have. */
  "slotManagers",
  /** Screenshot-verification configs a guild may have. */
  "ssverifyConfigs",
  /** Media-partner entries a guild may have. */
  "mediaPartners",
  /** Auto-purge channels a guild may have. */
  "autopurgeChannels",
  // The features the entitlement gates on its own. There is no count to
  // cap, so the free tier has no entry for them and they are unlimited.
  /** Slot reminders a guild may set. */
  "slotReminders",
  /** IDP transfers a guild may make. */
  "idpTransfer",
  /** Screenshot-verification types a guild may use. */
  "screenshotTypes",
  /** Custom verification success messages a guild may set. */
  "successMessage",
] as const;

/**
 * The name of a premium-gated thing.
 *
 * The union is closed and it names the *features*, not the table's
 * entries: {@link FREE_TIER} is a partial record over it.
 */
export type FreeTierKey = (typeof FREE_TIER_FEATURES)[number];

/**
 * The allowances, with their exact numbers.
 *
 * {@link FREE_TIER} is this table typed as a partial record over the
 * feature union. The numbers live here so the type can keep them exact:
 * a capped feature reads as `3`, not as `number | undefined`.
 */
const FREE_TIER_VALUES = {
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

/**
 * The type of {@link FREE_TIER}.
 *
 * A partial record over {@link FreeTierKey}: the features the table
 * caps keep their exact number, so a reader that knows the feature is
 * capped reads a definite value; the features it does not cap have no
 * entry and read as `undefined`. That absence is the "unlimited" case,
 * and it is what makes it expressible.
 *
 * The set of features that do carry a number is derivable from this
 * type, so a caller that wants the capped half — a label per
 * allowance, say — does not have to keep its own list.
 */
export type FreeTierLimits = {
  readonly [K in keyof typeof FREE_TIER_VALUES]: (typeof FREE_TIER_VALUES)[K];
} & {
  readonly [K in Exclude<
    FreeTierKey,
    keyof typeof FREE_TIER_VALUES
  >]?: undefined;
};

/**
 * The free-tier allowances (D45).
 *
 * **This is the canonical definition of the free tier.** The premium
 * area re-exports it: `modules/premium/limits.ts` is a re-export of
 * this table and not a second copy of it, so the perk list and the code
 * that enforces the limits are generated from one table and cannot
 * drift apart.
 *
 * `core/` is the lower layer: `modules/` may import from `core/`, never
 * the other way round, so the table has to live here.
 *
 * `core/guards.ts` never reads a number from the table: `countLimitGuard`
 * takes the limit as a parameter, so no allowance is hard-coded in the
 * runtime layer.
 *
 * The table is a **partial** record over {@link FreeTierKey}: it has an
 * entry for the features the free tier caps and none for the ones it
 * does not. A feature with no entry is unlimited.
 *
 * These are the limits the *code* enforces, not the ones the old perk
 * table advertised — the two had drifted apart, and the code is the one
 * users actually hit.
 */
export const FREE_TIER: FreeTierLimits = FREE_TIER_VALUES;

/**
 * Reads one allowance.
 *
 * @param key the gated thing to read.
 * @returns the limit, or `null` when the feature has no entry in the
 *          table and is therefore unlimited.
 */
export function freeTierLimit(key: FreeTierKey): number | null {
  return FREE_TIER[key] ?? null;
}
