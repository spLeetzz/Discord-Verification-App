/**
 * The entitlement check — one helper, one place (D15).
 *
 * `assertEntitled(guildId, feature)` is **the** way a premium gate is
 * enforced. Every gated path calls it, and it is always called **before**
 * the state it guards changes. Quotient's two live premium leaks — the
 * screenshot-type gate assigned the premium type before checking, and the
 * success-message gate existed in the editor but not in the wizard — are
 * impossible with one helper called first.
 *
 * Three rules the helper guarantees:
 *
 *  1. **Expiry is evaluated lazily at read time.** The row says
 *     `enabled` and `expires_at`; the decision is made when the row is
 *     read, not when a sweep last ran. Quotient only cleared the flag
 *     when a timer fired, so a missed sweep left a lapsed subscriber with
 *     premium forever.
 *  2. **An expired entitlement is inactive, not deleted.** Nothing here
 *     removes a row or a guild's configuration. A lapsed subscription stops
 *     selling; it does not destroy what the customer set up.
 *  3. **Nothing else in the codebase reads the entitlement table.** This
 *     module owns the table. The one exception is the {@link EntitlementLookup}
 *     adapter below, which exists only because `core/guards.ts` was
 *     written before this module landed and needs a boolean-shaped
 *     interface; it reads through exactly the same code path.
 */

import { PremiumRequiredError } from "../../core/errors.js";
import { gateReason } from "./gate.js";
import type { EntitlementSource, PremiumFeature } from "./types.js";
import { findEntitlement, listEntitlements } from "./repo.js";
import type { EntitlementRow } from "./repo.js";

/**
 * The refusal shown when a guild does not hold an entitlement.
 *
 * It names the feature **and** the upgrade path, because a refusal that
 * does not say what to do next is a support ticket.
 *
 * It is the same text the gate embed shows, so a gate that throws and a
 * gate that renders say the same thing.
 */
export const premiumRequiredMessage = gateReason;

/**
 * Is an entitlement row active right now?
 *
 * The rule, in one place: `enabled AND (expires_at IS NULL OR expires_at >
 * now())`. A row with no expiry never lapses.
 *
 * @param now the instant to judge against. Injectable so a test does not
 *            have to sleep.
 */
export function isEntitlementActive(
  row: EntitlementRow,
  now: Date = new Date(),
): boolean {
  if (!row.enabled) return false;

  if (row.expiresAt === null) return true;

  return row.expiresAt.getTime() > now.getTime();
}

/**
 * Does the guild hold the feature right now?
 *
 * The boolean form of {@link assertEntitled}, for callers that want a
 * question answered rather than a refusal raised.
 */
export async function isEntitled(
  guildId: string,
  feature: PremiumFeature,
): Promise<boolean> {
  const row = await findEntitlement(guildId, feature);

  if (!row) return false;

  return isEntitlementActive(row);
}

/**
 * Reads one entitlement, with the expiry already applied.
 *
 * `active` is the effective state — `enabled` and not expired. `expired`
 * says why an inactive row is inactive, so a message can say "this lapsed
 * on Tuesday" rather than "no".
 */
export interface EntitlementRecord {
  readonly guildId: string;
  readonly feature: PremiumFeature;
  /** The stored switch. */
  readonly enabled: boolean;
  /** The stored expiry, or `null` when it never expires. */
  readonly expiresAt: Date | null;
  /** How it was granted: `premium`, `owner` or `manual`. */
  readonly source: EntitlementSource;
  /** Whether the entitlement is in force right now. */
  readonly active: boolean;
  /** Whether it was switched on and has since run out. */
  readonly expired: boolean;
}

/**
 * Reads every entitlement a guild holds, with the expiry applied.
 */
export async function listEntitlementRecords(
  guildId: string,
): Promise<EntitlementRecord[]> {
  const rows = await listEntitlements(guildId);
  const now = new Date();

  return rows.map((row) => toRecord(row, now));
}

/**
 * Reads one entitlement, with the expiry applied.
 *
 * @returns the record, or `null` when the guild has never held the
 *          feature.
 */
export async function getEntitlementRecord(
  guildId: string,
  feature: PremiumFeature,
): Promise<EntitlementRecord | null> {
  const row = await findEntitlement(guildId, feature);

  if (!row) return null;

  return toRecord(row, new Date());
}

function toRecord(row: EntitlementRow, now: Date): EntitlementRecord {
  const active = isEntitlementActive(row, now);

  return {
    guildId: row.guildId,
    feature: row.feature,
    enabled: row.enabled,
    expiresAt: row.expiresAt,
    source: row.source,
    active,
    expired: row.enabled && row.expiresAt !== null && !active,
  };
}

/**
 * **The gate.**
 *
 * Throws when the guild does not hold the feature; returns quietly when it
 * does. Call it **before** the state it guards changes — the check is
 * free, the mutation is not, and a mutation that happens first cannot be
 * undone by a refusal.
 *
 * @throws {PremiumRequiredError} — a `DenialError`, so the dispatcher
 *         shows the message instead of reporting a crash.
 */
export async function assertEntitled(
  guildId: string,
  feature: PremiumFeature,
): Promise<void> {
  const row = await findEntitlement(guildId, feature);

  if (row && isEntitlementActive(row)) return;

  throw new PremiumRequiredError(feature, premiumRequiredMessage(feature));
}

/**
 * The entitlement lookup `core/guards.ts` expects.
 *
 * `premiumGuard(feature, lookup)` returns a *refusal string* rather than
 * throwing, so it needs a boolean-shaped interface. This adapter is that
 * interface, and it reads through the same {@link isEntitled} the rest of
 * the module uses — there is no second implementation of the expiry rule.
 *
 * ```ts
 * import { entitlementLookup } from "../modules/premium/entitlements.js";
 * import { Guards } from "../core/guards.js";
 *
 * const guard = Guards.premium(PremiumFeature.scrimSlots, entitlementLookup);
 * ```
 */
export const entitlementLookup = {
  isEntitled,

  async getEntitlement(guildId: string, feature: PremiumFeature) {
    const record = await getEntitlementRecord(guildId, feature);

    if (!record) return null;

    // `core/guards.ts` reads `enabled` as "in force right now", so the
    // effective flag is what goes there — the stored switch is on the
    // record for anyone who wants the detail.
    return {
      guildId: record.guildId,
      feature: record.feature,
      enabled: record.active,
      expiresAt: record.expiresAt,
      source: record.source,
    };
  },
};
