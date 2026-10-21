/**
 * Premium schema: the plan catalogue, the purchase state machine, and the
 * per-guild entitlements that the feature gates read.
 *
 * D37 replaces Quotient's "a nullable `completed_at` means success" with an
 * explicit `pending | paid | failed` status, so a failed purchase is
 * retryable and a pending one is visibly pending.
 *
 * D15 replaces Quotient's single `Guild.is_premium` boolean with one row per
 * (guild, feature). Expiry flips `enabled` — it never deletes the guild's
 * configuration.
 */

import {
  ENTITLEMENT_FEATURES,
  ENTITLEMENT_SOURCES,
  PREMIUM_TRANSACTION_STATUSES,
  oneOfCheck,
} from "./common.js";
import {
  boolCol,
  createdAtCol,
  defineTable,
  foreignIdCol,
  idCol,
  index,
  intCol,
  jsonCol,
  primaryKey,
  textCol,
  tsCol,
  unique,
  updatedAtCol,
} from "../dialect.js";

/**
 * A premium plan.
 *
 * `duration_days` is an integer, not an `INTERVAL`: Postgres intervals have
 * no lossless mapping to a JS number, and every plan duration is a whole
 * number of days anyway.
 *
 * `code` is the stable key the catalogue in `db/seed.ts` upserts on, so the
 * ids stay stable across restarts without hard-coding them. `name` is the
 * display name and is unique too — the source used it as the key.
 */
export const premiumPlans = defineTable(
  "premium_plans",
  {
    id: idCol(),
    code: textCol("code").notNull(),
    name: textCol("name").notNull(),
    description: textCol("description"),
    /** Price in whole rupees. */
    price: intCol("price").notNull(),
    /** Length of the subscription, in whole days. */
    durationDays: intCol("duration_days").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("premium_plans_code_unique").on(t.code),
    unique("premium_plans_name_unique").on(t.name),
  ],
);

/**
 * The plan as it was at purchase time.
 *
 * Quotient's plan table is destructively reseeded on every startup, so a
 * transaction that points only at a plan id renders a broken payment page
 * after the next restart. The snapshot keeps the receipt readable
 * regardless of what the catalogue does afterwards.
 */
export interface PremiumPlanSnapshot {
  /** The plan's display name at purchase time. */
  name: string;
  /** The price paid, in whole rupees. */
  price: number;
  /** The subscription length, in whole days. */
  duration_days: number;
}

/**
 * A premium purchase (D37).
 *
 * `txn_id` is the id we hand to the payment provider and it is the
 * idempotency key: `activatePremium(txnId, payload)` flips a `pending` row to
 * `paid` with a conditional update, so a replayed webhook cannot grant the
 * subscription twice.
 *
 * `plan_id` is nullable with `ON DELETE SET NULL`: a `RESTRICT` FK would
 * break the catalogue reseed, and a `CASCADE` would destroy paid
 * transactions. `plan_snapshot` is what the payment page reads instead.
 */
export const premiumTransactions = defineTable(
  "premium_transactions",
  {
    id: idCol(),
    txnId: textCol("txn_id").notNull(),
    status: textCol("status").notNull().default("pending"),
    userId: textCol("user_id").notNull(),
    guildId: textCol("guild_id").notNull(),
    planId: foreignIdCol("plan_id").references(() => premiumPlans.id, {
      onDelete: "set null",
    }),
    /** The plan as it was when the purchase was made. */
    planSnapshot: jsonCol<PremiumPlanSnapshot | null>("plan_snapshot"),
    /** The buyer's real address — Quotient sent a placeholder to the gateway. */
    email: textCol("email"),
    /** The buyer's Discord display name, for the receipt. */
    buyerName: textCol("buyer_name"),
    /** The raw provider payload, kept for audit. */
    rawData: jsonCol<Record<string, unknown>>("raw_data", {}),
    paidAt: tsCol("paid_at"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("premium_transactions_txn_id_unique").on(t.txnId),
    index("premium_transactions_user_id_idx").on(t.userId),
    index("premium_transactions_guild_id_idx").on(t.guildId),
    oneOfCheck(
      "premium_transactions_status_check",
      t.status,
      PREMIUM_TRANSACTION_STATUSES,
    ),
  ],
);

/**
 * One row per (guild, feature) (D15).
 *
 * The primary key is the pair, exactly as D15 specifies — a guild has at
 * most one row per feature, so the key *is* the invariant. `expires_at` is
 * null for an entitlement that never expires.
 *
 * `assertEntitled(guildId, feature)` is the only place a gate is read, and
 * it is always called *before* the state it guards changes.
 */
export const guildEntitlements = defineTable(
  "guild_entitlements",
  {
    guildId: textCol("guild_id").notNull(),
    feature: textCol("feature").notNull(),
    enabled: boolCol("enabled").notNull().default(false),
    expiresAt: tsCol("expires_at"),
    /** How the entitlement was granted: bought, owner-given, or manual. */
    source: textCol("source").notNull().default("owner"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.feature] }),
    oneOfCheck("guild_entitlements_feature_check", t.feature, ENTITLEMENT_FEATURES),
    oneOfCheck("guild_entitlements_source_check", t.source, ENTITLEMENT_SOURCES),
  ],
);
