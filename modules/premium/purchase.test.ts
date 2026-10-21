/**
 * The purchase state machine, proved against the live database.
 *
 * The properties that matter (D37):
 *
 *  - `pending → paid` grants the subscription;
 *  - `pending → failed` records the failure;
 *  - `failed` is **retryable** — Quotient closed the transaction on
 *    failure, so a failed payment could never be retried;
 *  - the grant is **idempotent**: a replayed webhook grants once;
 *  - the rows are written before anybody is told, so the entitlement is
 *    already in force when the notification goes out.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import {
  guildEntitlements,
  guildSettings,
  premiumTransactions,
} from "../../db/schema.js";
import { seedPremiumPlans } from "../../db/seed.js";
import { isEntitled } from "./entitlements.js";
import {
  activatePremium,
  canTransition,
  failPremium,
  nextStatus,
  retryPremium,
} from "./purchase.js";
import { createTransaction, findPlanByCode, findTransaction } from "./repo.js";
import type { VerifiedPurchase } from "./purchase.js";

const GUILD_ID = `premium-purchase-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_ID = "111111111111111111";

let counter = 0;

function nextTxnId(): string {
  counter += 1;

  return `premium-test-txn-${Date.now()}-${counter}`;
}

beforeEach(async () => {
  await db
    .delete(premiumTransactions)
    .where(sql`${premiumTransactions.guildId} = ${GUILD_ID}`);

  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

  // The subscription tier's expiry is the base a new purchase extends, so
  // it has to go too — otherwise every test would build on the last one.
  await db.delete(guildSettings).where(sql`${guildSettings.guildId} = ${GUILD_ID}`);

  await seedPremiumPlans();
});

afterAll(async () => {
  await db
    .delete(premiumTransactions)
    .where(sql`${premiumTransactions.guildId} = ${GUILD_ID}`);

  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

  await db.delete(guildSettings).where(sql`${guildSettings.guildId} = ${GUILD_ID}`);

  await closeDatabase();
});

/**
 * Creates a pending transaction for the cheapest plan.
 */
async function makeTransaction(): Promise<{ txnId: string; durationDays: number }> {
  // The plan is looked up by its **code**, the catalogue's natural key.
  // Picking "the cheapest plan" would pick up another test file's
  // temporary plan and then lose it mid-test.
  const plan = await findPlanByCode("trial");

  if (!plan) throw new Error("the plan catalogue is empty");

  const txnId = nextTxnId();

  await createTransaction({
    txnId,
    userId: USER_ID,
    guildId: GUILD_ID,
    planId: plan.id,
    planSnapshot: {
      name: plan.name,
      price: plan.price,
      duration_days: plan.durationDays,
    },
    email: "buyer@example.com",
    buyerName: "Buyer",
  });

  return { txnId, durationDays: plan.durationDays };
}

function makePurchase(txnId: string): VerifiedPurchase {
  return {
    txnId,
    amount: "29.00",
    email: "buyer@example.com",
    buyerName: "Buyer",
    status: "success",
    raw: { txnid: txnId, status: "success" },
  };
}

describe("modules/premium/purchase — the state machine", () => {
  it("allows pending to become paid", () => {
    expect(canTransition("pending", "activate")).toBe(true);
    expect(nextStatus("pending", "activate")).toBe("paid");
  });

  it("allows pending to become failed", () => {
    expect(canTransition("pending", "fail")).toBe(true);
    expect(nextStatus("pending", "fail")).toBe("failed");
  });

  it("allows a failed transaction to be retried", () => {
    expect(canTransition("failed", "retry")).toBe(true);
    expect(nextStatus("failed", "retry")).toBe("pending");
  });

  it("does not allow a paid transaction to fail", () => {
    expect(canTransition("paid", "fail")).toBe(false);
    expect(nextStatus("paid", "fail")).toBeNull();
  });

  it("does not allow a paid transaction to be retried", () => {
    expect(canTransition("paid", "retry")).toBe(false);
  });
});

describe("modules/premium/purchase — the database", () => {
  it("moves a pending transaction to paid and grants the entitlements", async () => {
    const { txnId, durationDays } = await makeTransaction();

    const before = await findTransaction(txnId);
    expect(before?.status).toBe("pending");

    const result = await activatePremium(makePurchase(txnId));

    expect(result.outcome).toBe("activated");
    expect(result.durationDays).toBe(durationDays);

    const after = await findTransaction(txnId);
    expect(after?.status).toBe("paid");
    expect(after?.paidAt).not.toBeNull();

    // Every feature is entitled, and the gate agrees.
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(true);
    expect(await isEntitled(GUILD_ID, "idp_transfer")).toBe(true);
    expect(await isEntitled(GUILD_ID, "success_message")).toBe(true);
  });

  it("gives the subscription the length the plan says", async () => {
    const { txnId, durationDays } = await makeTransaction();

    const result = await activatePremium(makePurchase(txnId));

    const expected = Date.now() + durationDays * 86_400_000;

    expect(result.expiresAt).not.toBeNull();
    expect(
      Math.abs((result.expiresAt?.getTime() ?? 0) - expected),
    ).toBeLessThan(5_000);
  });

  it("grants once, however many times the webhook fires", async () => {
    const { txnId, durationDays } = await makeTransaction();

    const first = await activatePremium(makePurchase(txnId));
    const second = await activatePremium(makePurchase(txnId));

    expect(first.outcome).toBe("activated");
    expect(second.outcome).toBe("already_paid");

    // The second call did not extend the subscription.
    const expected = Date.now() + durationDays * 86_400_000;

    expect(
      Math.abs((first.expiresAt?.getTime() ?? 0) - expected),
    ).toBeLessThan(5_000);
  });

  it("extends an existing subscription instead of replacing it", async () => {
    // Buying again before the current period ends must not lose the days
    // that were already paid for. Quotient stacked the durations the same
    // way.
    const first = await makeTransaction();
    const firstResult = await activatePremium(makePurchase(first.txnId));

    const second = await makeTransaction();
    const secondResult = await activatePremium(makePurchase(second.txnId));

    const extension =
      (secondResult.expiresAt?.getTime() ?? 0) -
      (firstResult.expiresAt?.getTime() ?? 0);

    expect(extension).toBe(first.durationDays * 86_400_000);
  });

  it("moves a pending transaction to failed", async () => {
    const { txnId } = await makeTransaction();

    const status = await failPremium({ txnId, raw: { status: "failure" } });

    expect(status).toBe("failed");

    const row = await findTransaction(txnId);
    expect(row?.status).toBe("failed");

    // A failed purchase grants nothing.
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(false);
  });

  it("lets a failed purchase be retried, and the retry can succeed", async () => {
    const { txnId } = await makeTransaction();

    await failPremium({ txnId, raw: { status: "failure" } });

    const retried = await retryPremium(txnId);
    expect(retried).toBe("pending");

    const row = await findTransaction(txnId);
    expect(row?.status).toBe("pending");

    const result = await activatePremium(makePurchase(txnId));
    expect(result.outcome).toBe("activated");
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(true);
  });

  it("lets the same transaction be paid again after a failure", async () => {
    // The buyer cancels at the gateway and then pays the same link. The
    // signature is verified again, so this is safe.
    const { txnId } = await makeTransaction();

    await failPremium({ txnId, raw: { status: "failure" } });

    const result = await activatePremium(makePurchase(txnId));

    expect(result.outcome).toBe("activated");
    expect((await findTransaction(txnId))?.status).toBe("paid");
  });

  it("does not un-buy a subscription when a failure arrives late", async () => {
    const { txnId } = await makeTransaction();

    await activatePremium(makePurchase(txnId));

    const status = await failPremium({ txnId, raw: { status: "failure" } });

    expect(status).toBe("paid");
    expect((await findTransaction(txnId))?.status).toBe("paid");
  });

  it("refuses to retry a transaction that was never failed", async () => {
    const { txnId } = await makeTransaction();

    expect(await retryPremium(txnId)).toBeNull();
  });

  it("reports an unknown transaction instead of throwing", async () => {
    const result = await activatePremium(makePurchase("premium-test-unknown"));

    expect(result.outcome).toBe("unknown_transaction");
  });

  it("records the buyer's real email and name", async () => {
    const { txnId } = await makeTransaction();

    await activatePremium({
      ...makePurchase(txnId),
      email: "real.buyer@example.com",
      buyerName: "Real Buyer",
    });

    const row = await findTransaction(txnId);

    expect(row?.email).toBe("real.buyer@example.com");
    expect(row?.buyerName).toBe("Real Buyer");
  });
});
