/**
 * The premium domain types.
 *
 * One place for the closed unions the premium system speaks in, so the
 * entitlement table's `CHECK` constraint, the gates, the purchase flow and
 * the commands all agree about what a "feature" is.
 *
 * The feature list is read from the **schema** rather than written out
 * here: `guild_entitlements.feature` has a `CHECK` constraint generated
 * from `ENTITLEMENT_FEATURES`, and a list written twice is a list that
 * drifts. `modules/premium/types.test.ts` proves the schema's list and the
 * runtime union in `core/constants.ts` are the same set.
 */

import { ENTITLEMENT_FEATURES } from "../../db/schema/common.js";
import type {
  EntitlementSource,
  PremiumTransactionStatus,
} from "../../db/schema/common.js";
import type { PremiumPlanSnapshot } from "../../db/schema/premium.js";
import type { PremiumFeature } from "../../core/premium.js";

export type { PremiumFeature } from "../../core/premium.js";
export type { EntitlementSource, PremiumTransactionStatus } from "../../db/schema/common.js";

/**
 * Every feature a guild can hold an entitlement for, in the order the
 * schema declares them.
 *
 * This is the list the `guild_entitlements_feature_check` constraint is
 * generated from, and it is the list the perk table is built from.
 */
export const PREMIUM_FEATURES: readonly PremiumFeature[] = ENTITLEMENT_FEATURES;

/**
 * What each feature is called in a message.
 *
 * The keys are the feature names, so a new feature cannot be added without
 * also being given a name — the record type makes the compiler say so.
 */
export const FEATURE_LABELS: Record<PremiumFeature, string> = {
  scrim_slots: "Extra scrim slots",
  slot_reminders: "Slot reminders",
  idp_transfer: "IDP transfer",
  extra_channels: "Extra tag-check and easy-tag channels",
  screenshot_types: "Every screenshot verification type",
  success_message: "A custom verification success message",
};

/**
 * The product description sent to the payment provider.
 *
 * PayU signs the product description along with the amount, so it is part
 * of the hash and cannot be changed per purchase.
 */
export const PRODUCT_INFO = "premium";

/**
 * A plan, as the catalogue describes it.
 */
export interface PremiumPlanView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  /** Price in whole rupees. */
  readonly price: number;
  /** Length of the subscription, in whole days. */
  readonly durationDays: number;
}

/**
 * A purchase, as the transaction table describes it.
 */
export interface PremiumTransactionView {
  readonly id: string;
  readonly txnId: string;
  readonly status: PremiumTransactionStatus;
  readonly userId: string;
  readonly guildId: string;
  readonly planId: string | null;
  readonly planSnapshot: PremiumPlanSnapshot | null;
  readonly email: string | null;
  readonly buyerName: string | null;
  readonly rawData: Record<string, unknown>;
  readonly paidAt: Date | null;
  readonly createdAt: Date;
}

/**
 * An entitlement row, as the table describes it.
 */
export interface EntitlementView {
  readonly guildId: string;
  readonly feature: PremiumFeature;
  readonly enabled: boolean;
  readonly expiresAt: Date | null;
  readonly source: EntitlementSource;
}
