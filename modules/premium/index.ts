/**
 * The premium module.
 *
 * Everything the rest of the codebase needs is re-exported here, so there
 * is one import path to learn:
 *
 * ```ts
 * import { assertEntitled } from "../modules/premium/index.js";
 * ```
 *
 * The parts other engineers depend on most:
 *
 *  - {@link assertEntitled} — **the** gate. One helper, one place.
 *  - {@link buildPremiumGateEmbed} — **the** way a gate refuses.
 *  - {@link FREE_TIER} — the free-tier allowances (D45).
 *  - {@link startPremiumServer} / {@link stopPremiumServer} — the payment
 *    server (D42).
 */

export {
  assertEntitled,
  entitlementLookup,
  getEntitlementRecord,
  isEntitled,
  isEntitlementActive,
  listEntitlementRecords,
  premiumRequiredMessage,
} from "./entitlements.js";
export type { EntitlementRecord } from "./entitlements.js";

export {
  buildPerksEmbed,
  buildPremiumBuyButton,
  buildPremiumBuyRow,
  buildPremiumGate,
  buildPremiumGateEmbed,
  buildStatusEmbed,
  gateReason,
  PREMIUM_BUY_CUSTOM_ID,
  PREMIUM_EMBED_COLOR,
  PREMIUM_MODULE,
} from "./gate.js";
export type { PremiumGate } from "./gate.js";

export {
  buildPerkLines,
  buildPerkText,
  freeTierLimit,
  FREE_TIER,
  FREE_TIER_LABELS,
} from "./limits.js";
export type { FreeTierKey } from "./limits.js";

export {
  FEATURE_LABELS,
  PREMIUM_FEATURES,
  PRODUCT_INFO,
} from "./types.js";
export type {
  EntitlementSource,
  PremiumFeature,
  PremiumTransactionStatus,
} from "./types.js";

export {
  activatePremium,
  canTransition,
  failPremium,
  nextStatus,
  retryPremium,
} from "./purchase.js";
export type {
  ActivationOutcome,
  ActivationResult,
  PremiumTransition,
  VerifiedPurchase,
} from "./purchase.js";

export {
  constantTimeEquals,
  formatAmount,
  amountsEqual,
  isPayuOrigin,
  isSuccessfulStatus,
  payuRequestHash,
  payuResponseHash,
  verifyPayuCallback,
} from "./payu.js";
export type {
  PayuCallbackExpectation,
  PayuCallbackPayload,
  PayuCredentials,
  PayuHashInput,
  PayuVerification,
} from "./payu.js";

export {
  buildCheckoutUrl,
  getCheckoutConfig,
  setCheckoutConfig,
} from "./checkout.js";
export type { CheckoutConfig } from "./checkout.js";

export {
  createDiscordNotifier,
  registerPremiumInteractions,
  stopPremiumInteractions,
} from "./views.js";
export type {
  PremiumButtonHandler,
  PremiumInteractionHandlers,
  PremiumModalHandler,
  PremiumSelectHandler,
} from "./views.js";

export {
  readPayuCredentials,
  startPremiumServer,
  stopPremiumServer,
} from "./server/index.js";
export type {
  PremiumServerHandle,
  PremiumServerOptions,
} from "./server/index.js";

export { premiumCommand, premiumStatusCommand } from "./commands/index.js";

export type { PremiumNotifier, PurchaseNotification } from "./notifications.js";
