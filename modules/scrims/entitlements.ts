/**
 * The premium seam for the scrims area.
 *
 * D15: `assertEntitled(guildId, feature)` is the **only** place a gate is
 * enforced, and the check happens **before** the state it guards changes.
 *
 * `modules/premium/` is owned by another engineer and had not landed when
 * this area was built. This file is a local implementation of the
 * documented signature — `assertEntitled(guildId: string, feature:
 * PremiumFeature): Promise<void>`, throwing the target's `DenialError` —
 * so the area can be built, typechecked and tested now.
 *
 * **When the premium module lands, delete this file and re-point the
 * imports at `modules/premium/entitlements.js`.** The call sites do not
 * change: they call `assertEntitled(guildId, feature)` and let the
 * refusal travel.
 *
 * The free-tier allowance is read from `FREE_TIER` in `core/premium.ts`
 * (D45), never hard-coded. When `modules/premium/limits.ts` lands it
 * becomes the single source; the import below is the only thing that
 * moves.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { guildEntitlements } from "../../db/schema.js";
import { PremiumFeature } from "../../core/constants.js";
import { PremiumRequiredError } from "../../core/errors.js";
import { FREE_TIER } from "../../core/premium.js";

export { PremiumFeature };

/** How many scrims a guild may have before it needs the entitlement. */
export const FREE_SCrim_LIMIT = FREE_TIER.scrims;

/**
 * Does the guild hold the entitlement right now?
 *
 * "Right now" means the row exists, is enabled, and has not expired. An
 * expired entitlement is inactive, not deleted (D15).
 */
export async function isEntitled(
  guildId: string,
  feature: PremiumFeature,
): Promise<boolean> {
  const rows = await db
    .select({ enabled: guildEntitlements.enabled, expiresAt: guildEntitlements.expiresAt })
    .from(guildEntitlements)
    .where(
      and(
        eq(guildEntitlements.guildId, guildId),
        eq(guildEntitlements.feature, feature),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (!row) return false;
  if (!row.enabled) return false;

  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;

  return true;
}

/**
 * Refuses when the guild does not hold the entitlement.
 *
 * @throws PremiumRequiredError — which is a `DenialError`, so the
 *         dispatcher shows it as a refusal rather than a crash.
 */
export async function assertEntitled(
  guildId: string,
  feature: PremiumFeature,
): Promise<void> {
  if (await isEntitled(guildId, feature)) return;

  throw new PremiumRequiredError(
    feature,
    `This feature needs a premium entitlement for **${feature}**. Please upgrade to unlock it.`,
  );
}
