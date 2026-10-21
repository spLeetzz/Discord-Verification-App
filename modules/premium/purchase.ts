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
 * **The grant is one transaction.** The transaction row and the seven
 * entitlement rows are written by a single `withLockedTransaction`, so
 * either all of it lands or none of it does. They used to be separate
 * statements: the transaction was flipped to `paid` and committed, and the
 * entitlements were written afterwards. A process killed in between left a
 * buyer who had paid with nothing, and no code path could repair it.
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
  listEntitlements,
  lockGuildSettings,
  markTransactionFailed,
  markTransactionPaid,
  recountUserPremiums,
  restoreGuildPremium,
  restoreUserPremium,
  retryTransaction,
  setGuildPremium,
  setUserPremium,
  upsertEntitlement,
  withLockedTransaction,
} from "./repo.js";
import type { DbExecutor, EntitlementRow, TransactionRow } from "./repo.js";
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
  /** The purchase was granted. */
  | "activated"
  /** The purchase was already granted, and the grant was whole. */
  | "already_paid"
  /**
   * The purchase was already paid for, but the grant was not whole, and
   * it has been put back together.
   */
  | "repaired"
  /** There is no such transaction. */
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
 * finds the transaction already `paid`, checks that the grant is whole,
 * and does nothing when it is.
 *
 * **One transaction.** The state change and every entitlement are written
 * by a single `withLockedTransaction`, so the two cannot drift apart: a
 * process killed half-way through the grant leaves the transaction
 * `pending` and no entitlement rows, and the next callback grants it
 * properly.
 *
 * @param purchase a payment whose signature has already been verified.
 */
export async function activatePremium(
  purchase: VerifiedPurchase,
): Promise<ActivationResult> {
  const outcome = await withLockedTransaction(
    purchase.txnId,
    async (transaction, tx) => {
      if (transaction.status === "paid") {
        return repairPaidTransaction(transaction, purchase, tx);
      }

      return grantPurchase(transaction, purchase, tx);
    },
  );

  return outcome ?? emptyResult(purchase, "unknown_transaction");
}

/**
 * Grants the purchase: the transaction becomes `paid` and every feature
 * the plan unlocks becomes entitled, with one expiry.
 */
async function grantPurchase(
  transaction: TransactionRow,
  purchase: VerifiedPurchase,
  tx: DbExecutor,
): Promise<ActivationResult> {
  const snapshot = transaction.planSnapshot;
  const durationDays = snapshot?.duration_days ?? 0;
  const now = new Date();

  // The rows the grant writes to have to exist before they can be
  // written, and the guild's row is **locked** while it is read: two
  // purchases for the same guild would otherwise both read the same
  // expiry and both extend it, and one subscription would be lost.
  await ensureGuildSettings(transaction.guildId, tx);
  await ensureUserSettings(transaction.userId, tx);

  const settings = await lockGuildSettings(transaction.guildId, tx);

  // The subscription extends an existing one rather than replacing it, so
  // buying again before the current period ends does not lose the days
  // that were already paid for.
  const base =
    settings?.premiumExpiresAt &&
    settings.premiumExpiresAt.getTime() > now.getTime()
      ? settings.premiumExpiresAt
      : now;

  const expiresAt = new Date(base.getTime() + durationDays * DAY_MS);

  // 1. The transaction becomes `paid`.
  const paid = await markTransactionPaid(
    {
      txnId: purchase.txnId,
      email: purchase.email,
      buyerName: purchase.buyerName,
      rawData: purchase.raw,
      paidAt: now,
    },
    tx,
  );

  if (!paid) {
    // The row was neither `pending` nor `failed` after all. The lock
    // means this cannot be a race with another webhook — the state
    // machine lives in the database, and the database has the last word.
    // Throwing rolls the whole grant back, so nothing is half-written.
    throw new Error(
      `the transaction ${purchase.txnId} is "${transaction.status}" and cannot be activated`,
    );
  }

  // 2. Every feature the plan unlocks becomes entitled, with the same
  //    expiry. The check happens on the *next* read, so nothing here has
  //    to schedule an expiry job.
  for (const feature of PREMIUM_FEATURES) {
    await upsertEntitlement(
      {
        guildId: transaction.guildId,
        feature,
        enabled: true,
        expiresAt,
        source: "premium",
      },
      tx,
    );
  }

  // 3. The summary rows the status command reads.
  await setGuildPremium(
    {
      guildId: transaction.guildId,
      expiresAt,
      madePremiumBy: transaction.userId,
    },
    tx,
  );

  await setUserPremium({ userId: transaction.userId, expiresAt }, tx);

  return toResult(transaction, purchase, "activated", expiresAt);
}

/**
 * Repairs a purchase that was paid for but never granted.
 *
 * The grant is one transaction now, so a `paid` row always has its
 * entitlements. It did not used to: the transaction was flipped to `paid`
 * and committed, and the entitlements were written afterwards, so a
 * process killed in between left a buyer who had paid with nothing — and
 * the replay path wrote nothing, because the transaction was already
 * `paid`.
 *
 * So a second callback for an already-`paid` transaction **checks** that
 * the grant is whole, and puts it back together when it is not.
 *
 * Two rules keep the repair from becoming a second grant:
 *
 *  - the expiry is the latest of what the purchase bought on its own, what
 *    the interrupted grant wrote, and what the guild already holds. It is
 *    never longer than the guild's own subscription, so a repair can never
 *    hand out a second set of days;
 *  - the user's subscription counter is recounted from the transactions
 *    rather than incremented, so a purchase is never counted twice.
 */
async function repairPaidTransaction(
  transaction: TransactionRow,
  purchase: VerifiedPurchase,
  tx: DbExecutor,
): Promise<ActivationResult> {
  const snapshot = transaction.planSnapshot;
  const durationDays = snapshot?.duration_days ?? 0;
  const paidAt = transaction.paidAt ?? transaction.createdAt;

  await ensureGuildSettings(transaction.guildId, tx);
  await ensureUserSettings(transaction.userId, tx);

  const settings = await lockGuildSettings(transaction.guildId, tx);
  const entitlements = await listEntitlements(transaction.guildId, tx);

  // The expiry the purchase bought on its own: the days that were paid
  // for, counted from the moment they were paid for.
  const ownExpiry = new Date(paidAt.getTime() + durationDays * DAY_MS);

  // The expiry the guild holds. A longer subscription is never shortened
  // by a repair.
  const guildExpiry = settings?.premiumExpiresAt ?? null;

  // The expiry the interrupted grant wrote, if any of its rows landed —
  // every row it wrote carried the same expiry.
  const witness = latestExpiry(entitlements);

  // What the grant wrote, or would have written: the days the purchase
  // bought, counted from the moment they were paid for — and the expiry
  // the interrupted grant itself wrote, when it got that far.
  const expected = latestDate([ownExpiry, witness]) ?? ownExpiry;

  const held = new Set(entitlements.map((row) => row.feature));
  const missing = PREMIUM_FEATURES.filter((feature) => !held.has(feature));

  // The grant is whole when every feature is entitled and the guild's
  // subscription runs at least as long as the purchase bought.
  const incomplete =
    missing.length > 0 ||
    guildExpiry === null ||
    guildExpiry.getTime() < expected.getTime();

  if (!incomplete) {
    // Nothing to repair, and nothing to extend: the subscription the
    // buyer holds is the one that is running.
    return toResult(
      transaction,
      purchase,
      "already_paid",
      settings?.premiumExpiresAt ?? null,
    );
  }

  // The repair never hands out a second set of days: the expiry is the
  // latest of what the purchase bought, what the interrupted grant
  // wrote, and what the guild already holds.
  const expiresAt = latestDate([expected, guildExpiry]) ?? expected;

  // The grant is all or nothing, so it is put back as a whole.
  for (const feature of PREMIUM_FEATURES) {
    await upsertEntitlement(
      {
        guildId: transaction.guildId,
        feature,
        enabled: true,
        expiresAt,
        source: "premium",
      },
      tx,
    );
  }

  await restoreGuildPremium(
    {
      guildId: transaction.guildId,
      expiresAt,
      madePremiumBy: transaction.userId,
    },
    tx,
  );

  await restoreUserPremium({ userId: transaction.userId, expiresAt }, tx);

  // The counter is a summary of the purchases, and the transactions are
  // the record of them: put the two back in step.
  await recountUserPremiums(transaction.userId, tx);

  return toResult(transaction, purchase, "repaired", expiresAt);
}

/**
 * The latest expiry on a set of entitlement rows.
 *
 * `null` when no row carries one — a row with no expiry never lapses, so
 * it is not a witness for a dated grant.
 */
function latestExpiry(rows: readonly EntitlementRow[]): Date | null {
  const dates = rows
    .map((row) => row.expiresAt)
    .filter((date): date is Date => date !== null);

  return latestDate(dates);
}

/** The latest of a list of dates, ignoring the nulls. */
function latestDate(dates: readonly (Date | null)[]): Date | null {
  let latest: Date | null = null;

  for (const date of dates) {
    if (!date) continue;

    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }

  return latest;
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
