/**
 * All the SQL the premium module owns, and nothing else.
 *
 * Five tables are touched here:
 *
 *  - `guild_entitlements` — the per-(guild, feature) entitlement (D15);
 *  - `premium_plans`      — the catalogue;
 *  - `premium_transactions` — the purchase state machine (D37);
 *  - `guild_settings` / `user_settings` — the subscription summary the
 *    status command shows.
 *
 * The rules that matter:
 *
 *  - **Expiry is evaluated lazily at read time.** Nothing here schedules a
 *    sweep and nothing here clears a flag when a timer fires; a lapsed
 *    subscription is inactive the moment it expires, whether or not any
 *    job ran. `isEntitlementActive` in `entitlements.ts` is the one place
 *    that decision is made.
 *  - **The transaction status is an explicit enum** (`pending | paid |
 *    failed`) and every write is a conditional update, so a replayed
 *    webhook cannot grant the subscription twice and a failed purchase can
 *    be retried.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, withTransaction } from "../../db/client.js";
import {
  guildEntitlements,
  guildSettings,
  premiumPlans,
  premiumTransactions,
  userSettings,
} from "../../db/schema.js";
import type { PremiumPlanSnapshot } from "../../db/schema/premium.js";
import type {
  EntitlementFeature,
  EntitlementSource,
  PremiumTransactionStatus,
} from "../../db/schema/common.js";

/** A day in milliseconds. Subscriptions are whole days (S12). */
export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ *
 * Entitlements
 * ------------------------------------------------------------------ */

/**
 * Reads one entitlement row.
 *
 * @returns the row, or `null` when the guild has never held the feature.
 */
export async function findEntitlement(
  guildId: string,
  feature: EntitlementFeature,
): Promise<EntitlementRow | null> {
  const [row] = await db
    .select({
      guildId: guildEntitlements.guildId,
      feature: guildEntitlements.feature,
      enabled: guildEntitlements.enabled,
      expiresAt: guildEntitlements.expiresAt,
      source: guildEntitlements.source,
    })
    .from(guildEntitlements)
    .where(
      and(
        eq(guildEntitlements.guildId, guildId),
        eq(guildEntitlements.feature, feature),
      ),
    )
    .limit(1);

  return row ? toEntitlementRow(row) : null;
}

/** Reads every entitlement row a guild holds. */
export async function listEntitlements(
  guildId: string,
): Promise<EntitlementRow[]> {
  const rows = await db
    .select({
      guildId: guildEntitlements.guildId,
      feature: guildEntitlements.feature,
      enabled: guildEntitlements.enabled,
      expiresAt: guildEntitlements.expiresAt,
      source: guildEntitlements.source,
    })
    .from(guildEntitlements)
    .where(eq(guildEntitlements.guildId, guildId))
    .orderBy(guildEntitlements.feature);

  return rows.map(toEntitlementRow);
}

/**
 * Writes an entitlement row.
 *
 * The primary key is `(guild_id, feature)`, so this is an upsert: granting
 * a feature twice updates the one row rather than making a second.
 */
export async function upsertEntitlement(input: {
  guildId: string;
  feature: EntitlementFeature;
  enabled: boolean;
  expiresAt: Date | null;
  source: EntitlementSource;
}): Promise<void> {
  await db
    .insert(guildEntitlements)
    .values({
      guildId: input.guildId,
      feature: input.feature,
      enabled: input.enabled,
      expiresAt: input.expiresAt,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [guildEntitlements.guildId, guildEntitlements.feature],
      set: {
        enabled: input.enabled,
        expiresAt: input.expiresAt,
        source: input.source,
        updatedAt: new Date(),
      },
    });
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

/** The plan catalogue, cheapest first. */
export async function listPlans(): Promise<PlanRow[]> {
  return db
    .select({
      id: premiumPlans.id,
      code: premiumPlans.code,
      name: premiumPlans.name,
      description: premiumPlans.description,
      price: premiumPlans.price,
      durationDays: premiumPlans.durationDays,
    })
    .from(premiumPlans)
    .orderBy(premiumPlans.price);
}

/** One plan by its id. */
export async function findPlan(planId: string): Promise<PlanRow | null> {
  const [row] = await db
    .select({
      id: premiumPlans.id,
      code: premiumPlans.code,
      name: premiumPlans.name,
      description: premiumPlans.description,
      price: premiumPlans.price,
      durationDays: premiumPlans.durationDays,
    })
    .from(premiumPlans)
    .where(eq(premiumPlans.id, planId))
    .limit(1);

  return row ?? null;
}

/**
 * One plan by its code.
 *
 * The code is the catalogue's natural key — the seed upserts on it, so the
 * ids stay stable across restarts without anybody hard-coding them. A
 * lookup by code is therefore the one that survives a reseed.
 */
export async function findPlanByCode(code: string): Promise<PlanRow | null> {
  const [row] = await db
    .select({
      id: premiumPlans.id,
      code: premiumPlans.code,
      name: premiumPlans.name,
      description: premiumPlans.description,
      price: premiumPlans.price,
      durationDays: premiumPlans.durationDays,
    })
    .from(premiumPlans)
    .where(eq(premiumPlans.code, code))
    .limit(1);

  return row ?? null;
}

/* ------------------------------------------------------------------ *
 * Transactions
 * ------------------------------------------------------------------ */

/**
 * Creates a pending transaction.
 *
 * The plan is **snapshotted** into `plan_snapshot` at this moment, so the
 * payment page still renders after the catalogue changes and the receipt
 * still says what was bought (D37).
 */
export async function createTransaction(input: {
  txnId: string;
  userId: string;
  guildId: string;
  planId: string;
  planSnapshot: PremiumPlanSnapshot;
  email: string;
  buyerName: string;
}): Promise<TransactionRow> {
  const [row] = await db
    .insert(premiumTransactions)
    .values({
      txnId: input.txnId,
      status: "pending",
      userId: input.userId,
      guildId: input.guildId,
      planId: input.planId,
      planSnapshot: input.planSnapshot,
      email: input.email,
      buyerName: input.buyerName,
    })
    .returning(transactionColumns);

  if (!row) {
    throw new Error(`could not create the transaction ${input.txnId}`);
  }

  return toTransactionRow(row);
}

/** Reads a transaction by its id. */
export async function findTransaction(
  txnId: string,
): Promise<TransactionRow | null> {
  const [row] = await db
    .select(transactionColumns)
    .from(premiumTransactions)
    .where(eq(premiumTransactions.txnId, txnId))
    .limit(1);

  return row ? toTransactionRow(row) : null;
}

/** Reads every transaction a user made, newest first. */
export async function listTransactionsForUser(
  userId: string,
): Promise<TransactionRow[]> {
  const rows = await db
    .select(transactionColumns)
    .from(premiumTransactions)
    .where(eq(premiumTransactions.userId, userId))
    .orderBy(sql`${premiumTransactions.createdAt} desc`);

  return rows.map(toTransactionRow);
}

/**
 * Moves a transaction to `paid`.
 *
 * The `WHERE` clause is the state machine: only a `pending` or a `failed`
 * transaction can become `paid`, so a replayed webhook updates nothing.
 * A `paid` transaction is terminal.
 *
 * @returns `true` when the row was updated.
 */
export async function markTransactionPaid(input: {
  txnId: string;
  email: string | null;
  buyerName: string | null;
  rawData: Record<string, unknown>;
  paidAt: Date;
}): Promise<boolean> {
  const updated = await db
    .update(premiumTransactions)
    .set({
      status: "paid",
      paidAt: input.paidAt,
      email: input.email,
      buyerName: input.buyerName,
      rawData: input.rawData,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(premiumTransactions.txnId, input.txnId),
        inArray(premiumTransactions.status, ["pending", "failed"]),
      ),
    )
    .returning({ id: premiumTransactions.id });

  return updated.length > 0;
}

/**
 * Moves a transaction to `failed`.
 *
 * Only a `pending` transaction can fail. A `paid` one is terminal — a
 * failure callback must not un-buy a subscription that already succeeded.
 *
 * @returns `true` when the row was updated.
 */
export async function markTransactionFailed(input: {
  txnId: string;
  rawData: Record<string, unknown>;
}): Promise<boolean> {
  const updated = await db
    .update(premiumTransactions)
    .set({
      status: "failed",
      rawData: input.rawData,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(premiumTransactions.txnId, input.txnId),
        eq(premiumTransactions.status, "pending"),
      ),
    )
    .returning({ id: premiumTransactions.id });

  return updated.length > 0;
}

/**
 * Moves a `failed` transaction back to `pending`, so the buyer can try
 * again with the same transaction id.
 *
 * @returns `true` when the row was updated.
 */
export async function retryTransaction(txnId: string): Promise<boolean> {
  const updated = await db
    .update(premiumTransactions)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(premiumTransactions.txnId, txnId),
        eq(premiumTransactions.status, "failed"),
      ),
    )
    .returning({ id: premiumTransactions.id });

  return updated.length > 0;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** The guild's settings row, creating it if it does not exist yet. */
export async function ensureGuildSettings(guildId: string): Promise<void> {
  await db.insert(guildSettings).values({ guildId }).onConflictDoNothing();
}

/** The user's settings row, creating it if it does not exist yet. */
export async function ensureUserSettings(userId: string): Promise<void> {
  await db.insert(userSettings).values({ userId }).onConflictDoNothing();
}

/** Reads the guild's settings row. */
export async function getGuildSettings(
  guildId: string,
): Promise<GuildSettingsRow | null> {
  const [row] = await db
    .select({
      guildId: guildSettings.guildId,
      premiumExpiresAt: guildSettings.premiumExpiresAt,
      madePremiumBy: guildSettings.madePremiumBy,
    })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .limit(1);

  return row ?? null;
}

/** Reads the user's settings row. */
export async function getUserSettings(
  userId: string,
): Promise<UserSettingsRow | null> {
  const [row] = await db
    .select({
      userId: userSettings.userId,
      isPremium: userSettings.isPremium,
      premiumExpireTime: userSettings.premiumExpireTime,
      premiums: userSettings.premiums,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  return row ?? null;
}

/**
 * Records the subscription on the user's row.
 *
 * `premiums` counts how many subscriptions the user holds — it is a
 * counter, and it is incremented in SQL so two purchases cannot lose one
 * between them.
 */
export async function setUserPremium(input: {
  userId: string;
  expiresAt: Date;
}): Promise<void> {
  await db
    .update(userSettings)
    .set({
      isPremium: true,
      premiumExpireTime: input.expiresAt,
      premiums: sql`${userSettings.premiums} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, input.userId));
}

/** Records the subscription on the guild's row. */
export async function setGuildPremium(input: {
  guildId: string;
  expiresAt: Date;
  madePremiumBy: string;
}): Promise<void> {
  await db
    .update(guildSettings)
    .set({
      premiumExpiresAt: input.expiresAt,
      madePremiumBy: input.madePremiumBy,
      updatedAt: new Date(),
    })
    .where(eq(guildSettings.guildId, input.guildId));
}

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

/** The columns read from `guild_entitlements`. */
export interface EntitlementRow {
  readonly guildId: string;
  readonly feature: EntitlementFeature;
  readonly enabled: boolean;
  readonly expiresAt: Date | null;
  readonly source: EntitlementSource;
}

/** The columns read from `premium_plans`. */
export interface PlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly durationDays: number;
}

/** The columns read from `premium_transactions`. */
export interface TransactionRow {
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

/** The columns read from `guild_settings`. */
export interface GuildSettingsRow {
  readonly guildId: string;
  readonly premiumExpiresAt: Date | null;
  readonly madePremiumBy: string | null;
}

/** The columns read from `user_settings`. */
export interface UserSettingsRow {
  readonly userId: string;
  readonly isPremium: boolean;
  readonly premiumExpireTime: Date | null;
  readonly premiums: number;
}

/**
 * The `feature`, `source` and `status` columns are `text` with `CHECK`
 * constraints generated from the closed unions, so the database guarantees
 * the value is one of the allowed ones. Drizzle types a `text` column as
 * `string`; the constraint is what narrows it, and these mappers are where
 * that happens.
 */
function toEntitlementRow(row: {
  guildId: string;
  feature: string;
  enabled: boolean;
  expiresAt: Date | null;
  source: string;
}): EntitlementRow {
  return {
    guildId: row.guildId,
    feature: row.feature as EntitlementFeature,
    enabled: row.enabled,
    expiresAt: row.expiresAt,
    source: row.source as EntitlementSource,
  };
}

function toTransactionRow(row: {
  id: string;
  txnId: string;
  status: string;
  userId: string;
  guildId: string;
  planId: string | null;
  planSnapshot: PremiumPlanSnapshot | null;
  email: string | null;
  buyerName: string | null;
  rawData: unknown;
  paidAt: Date | null;
  createdAt: Date;
}): TransactionRow {
  return {
    id: row.id,
    txnId: row.txnId,
    status: row.status as PremiumTransactionStatus,
    userId: row.userId,
    guildId: row.guildId,
    planId: row.planId,
    planSnapshot: row.planSnapshot,
    email: row.email,
    buyerName: row.buyerName,
    rawData: (row.rawData ?? {}) as Record<string, unknown>,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

const transactionColumns = {
  id: premiumTransactions.id,
  txnId: premiumTransactions.txnId,
  status: premiumTransactions.status,
  userId: premiumTransactions.userId,
  guildId: premiumTransactions.guildId,
  planId: premiumTransactions.planId,
  planSnapshot: premiumTransactions.planSnapshot,
  email: premiumTransactions.email,
  buyerName: premiumTransactions.buyerName,
  rawData: premiumTransactions.rawData,
  paidAt: premiumTransactions.paidAt,
  createdAt: premiumTransactions.createdAt,
} as const;

/**
 * Runs `fn` with a locked transaction row.
 *
 * The `SELECT … FOR UPDATE` is what makes two concurrent webhooks for the
 * same transaction safe: the second one waits for the first to commit and
 * then sees the row already `paid`.
 *
 * @returns whatever `fn` returned, or `null` when the transaction does
 *          not exist.
 */
export async function withLockedTransaction<T>(
  txnId: string,
  fn: (transaction: TransactionRow) => Promise<T>,
): Promise<T | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select(transactionColumns)
      .from(premiumTransactions)
      .where(eq(premiumTransactions.txnId, txnId))
      .for("update");

    if (!row) return null;

    return fn(toTransactionRow(row));
  });
}
