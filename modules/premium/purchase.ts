/**
 * The purchase state machine (D37).
 *
 * Quotient's model was a nullable `completed_at`: a transaction was either
 * open or closed, and closing it on failure meant **a failed payment could
 * never be retried**. The state here is explicit:
 *
 * ```
 *   pending ──activate──▶ paid      (terminal)
 *      │
 *      └────fail──────▶ failed ──retry──▶ pending
 *                            │
 *                            └──activate──▶ paid
 * ```
 *
 * `failed → paid` exists because a buyer who cancels at the gateway and
 * then pays the same transaction id has, in fact, paid. The signature is
 * verified before either transition, so a failure callback can never
 * un-buy a subscription that already succeeded.
 *
 * Every write is a conditional `UPDATE`, so the state machine lives in the
 * database and not only in this file: a replayed webhook updates zero rows.
 *
 * **The rows are written before anybody is told.** Quotient dispatched the
 * purchase notification before the guild row was written, so the
 * confirmation DM could show a stale expiry or crash on `None`. The
 * notification is the caller's job, after this function has returned.
 */

import {
  DAY_MS,
  ensureGuildSettings,
  ensureUserSettings,
  findTransaction,
  getGuildSettings,
  markTransactionFailed,
  markTransactionPaid,
  retryTransaction,
  setGuildPremium,
  setUserPremium,
  upsertEntitlement,
} from "./repo.js";
import type { TransactionRow } from "./repo.js";
import { PREMIUM_FEATURES } from "./types.js";
import type { PremiumTransactionStatus } from "./types.js";

/** The transitions a transaction can make. */
export type PremiumTransition = "activate" | "fail" | "retry";

/**
 * Is a transition legal from this state?
 *
 * The pure version of the rule the conditional `UPDATE`s enforce.
 */
export function canTransition(
  current: PremiumTransactionStatus,
  transition: PremiumTransition,
): boolean {
  switch (transition) {
    case "activate":
      return current === "pending" || current === "failed";
    case "fail":
      return current === "pending";
    case "retry":
      return current === "failed";
  }
}

/**
 * The state a transition leads to.
 *
 * @returns the new state, or `null` when the transition is not legal.
 */
export function nextStatus(
  current: PremiumTransactionStatus,
  transition: PremiumTransition,
): PremiumTransactionStatus | null {
  if (!canTransition(current, transition)) return null;

  switch (transition) {
    case "activate":
      return "paid";
    case "fail":
      return "failed";
    case "retry":
      return "pending";
  }
}

/**
 * A payment that has already been verified.
 *
 * The only way to build one is {@link verifyPayuCallback} — the fields
 * here come from a callback whose signature checked out.
 */
export interface VerifiedPurchase {
  readonly txnId: string;
  /** The amount PayU reported, as it sent it. */
  readonly amount: string;
  /** The buyer's real email. */
  readonly email: string;
  /** The buyer's Discord display name. */
  readonly buyerName: string;
  /** The status PayU reported. */
  readonly status: string;
  /** The whole provider payload, kept for audit. */
  readonly raw: Record<string, unknown>;
}

/** What happened to the purchase. */
export type ActivationOutcome =
  | "activated"
  | "already_paid"
  | "unknown_transaction";

/** The result of an activation. */
export interface ActivationResult {
  readonly outcome: ActivationOutcome;
  readonly txnId: string;
  readonly userId: string;
  readonly guildId: string;
  /** The plan's name, as it was when the purchase was made. */
  readonly planName: string;
  /** The plan's length, in whole days. */
  readonly durationDays: number;
  /** When the subscription runs out. */
  readonly expiresAt: Date | null;
  /** The amount that was paid, as a decimal string. */
  readonly amount: string;
  /** The buyer's real email. */
  readonly email: string;
  /** The buyer's Discord display name. */
  readonly buyerName: string;
}

/**
 * Grants the subscription for a verified purchase.
 *
 * Idempotent: calling it twice grants one subscription. The second call
 * finds the transaction already `paid` and does nothing.
 *
 * @param purchase a payment whose signature has already been verified.
 */
export async function activatePremium(
  purchase: VerifiedPurchase,
): Promise<ActivationResult> {
  const transaction = await findTransaction(purchase.txnId);

  if (!transaction) {
    return emptyResult(purchase, "unknown_transaction");
  }

  if (transaction.status === "paid") {
    // Idempotent: the subscription was already granted.
    const settings = await getGuildSettings(transaction.guildId);

    return toResult(
      transaction,
      purchase,
      "already_paid",
      settings?.premiumExpiresAt ?? null,
    );
  }

  const snapshot = transaction.planSnapshot;
  const durationDays = snapshot?.duration_days ?? 0;
  const now = new Date();

  // The subscription extends an existing one rather than replacing it, so
  // buying again before the current period ends does not lose the days
  // that were already paid for.
  await ensureGuildSettings(transaction.guildId);
  await ensureUserSettings(transaction.userId);

  const guildSettings = await getGuildSettings(transaction.guildId);

  const base =
    guildSettings?.premiumExpiresAt &&
    guildSettings.premiumExpiresAt.getTime() > now.getTime()
      ? guildSettings.premiumExpiresAt
      : now;

  const expiresAt = new Date(base.getTime() + durationDays * DAY_MS);

  // 1. The transaction becomes `paid`.
  const paid = await markTransactionPaid({
    txnId: purchase.txnId,
    email: purchase.email,
    buyerName: purchase.buyerName,
    rawData: purchase.raw,
    paidAt: now,
  });

  if (!paid) {
    // Somebody else activated it between the read and the write. The
    // subscription is granted once; the second grant is a no-op.
    const current = await findTransaction(purchase.txnId);

    if (!current) return emptyResult(purchase, "unknown_transaction");

    const settings = await getGuildSettings(current.guildId);

    return toResult(
      current,
      purchase,
      "already_paid",
      settings?.premiumExpiresAt ?? null,
    );
  }

  // 2. Every feature the plan unlocks becomes entitled, with the same
  //    expiry. The check happens on the *next* read, so nothing here has
  //    to schedule an expiry job.
  for (const feature of PREMIUM_FEATURES) {
    await upsertEntitlement({
      guildId: transaction.guildId,
      feature,
      enabled: true,
      expiresAt,
      source: "premium",
    });
  }

  // 3. The summary rows the status command reads.
  await setGuildPremium({
    guildId: transaction.guildId,
    expiresAt,
    madePremiumBy: transaction.userId,
  });

  await setUserPremium({ userId: transaction.userId, expiresAt });

  const updated = await findTransaction(purchase.txnId);

  return toResult(updated ?? transaction, purchase, "activated", expiresAt);
}

/**
 * Records a failed payment.
 *
 * A failed transaction is **retryable**: the buyer can pay the same
 * transaction id again, and the payment page still renders.
 */
export async function failPremium(input: {
  txnId: string;
  raw: Record<string, unknown>;
}): Promise<PremiumTransactionStatus | "unknown_transaction"> {
  const transaction = await findTransaction(input.txnId);

  if (!transaction) return "unknown_transaction";

  const failed = await markTransactionFailed({
    txnId: input.txnId,
    rawData: input.raw,
  });

  if (failed) return "failed";

  const current = await findTransaction(input.txnId);

  return current?.status ?? "unknown_transaction";
}

/**
 * Puts a failed transaction back in flight, so the buyer can try again.
 *
 * @returns the new status, or `null` when the transaction was not failed.
 */
export async function retryPremium(
  txnId: string,
): Promise<PremiumTransactionStatus | null> {
  const retried = await retryTransaction(txnId);

  if (!retried) return null;

  return "pending";
}

function emptyResult(
  purchase: VerifiedPurchase,
  outcome: ActivationOutcome,
): ActivationResult {
  return {
    outcome,
    txnId: purchase.txnId,
    userId: "",
    guildId: "",
    planName: "",
    durationDays: 0,
    expiresAt: null,
    amount: purchase.amount,
    email: purchase.email,
    buyerName: purchase.buyerName,
  };
}

function toResult(
  transaction: TransactionRow,
  purchase: VerifiedPurchase,
  outcome: ActivationOutcome,
  expiresAt: Date | null,
): ActivationResult {
  const snapshot = transaction.planSnapshot;

  return {
    outcome,
    txnId: transaction.txnId,
    userId: transaction.userId,
    guildId: transaction.guildId,
    planName: snapshot?.name ?? "",
    durationDays: snapshot?.duration_days ?? 0,
    expiresAt,
    amount: purchase.amount,
    email: purchase.email,
    buyerName: purchase.buyerName,
  };
}
