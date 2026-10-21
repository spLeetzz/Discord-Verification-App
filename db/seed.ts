/**
 * The premium plan catalogue.
 *
 * The plans live in code, not in a SQL seed file, for the same reason the
 * rest of the bot's configuration does: the file is the source of truth, it
 * is reviewable in a diff, and it cannot drift away from the code that reads
 * it. It matches the style of `config/events.ts`.
 *
 * The catalogue is upserted into `premium_plans` at startup by the module
 * that owns premium — `db/` never calls it on its own, because a schema
 * package that writes rows behind the caller's back is a schema package
 * with side effects.
 *
 * Quotient never called its own `insert_plans()`, so its `premium_plans`
 * table shipped empty and every purchase screen was blank. That gap is not
 * reproduced here: the premium module calls {@link seedPremiumPlans} on
 * startup.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "./client.js";
import { premiumPlans } from "./schema.js";

/**
 * The value the conflicting row was about to insert.
 *
 * `ON CONFLICT DO UPDATE` cannot take a bind parameter for the new value, so
 * the column has to be named in the expression. The name comes from our own
 * schema object, never from user input.
 */
function excluded(column: PgColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

/** One plan as the catalogue describes it. */
export interface PremiumPlanSeed {
  /** Stable key; the upsert conflicts on it. */
  code: string;
  name: string;
  description: string;
  /** Price in whole rupees. */
  price: number;
  /** Length of the subscription, in whole days. */
  durationDays: number;
}

/**
 * Quotient's five plans, ported exactly: the same names, the same
 * descriptions, the same prices, the same durations.
 *
 * The lifetime plan is 25185 days (69 years) in Quotient, not literally
 * forever — a subscription that never ends has no end date to remind the
 * owner about, and the payment provider wants a finite period anyway.
 */
export const PREMIUM_PLAN_CATALOGUE: PremiumPlanSeed[] = [
  {
    code: "trial",
    name: "Trial (7d)",
    description: "Duration: 7 days",
    price: 29,
    durationDays: 7,
  },
  {
    code: "basic",
    name: "Basic (1m)",
    description: "Duration: 28 days",
    price: 79,
    durationDays: 28,
  },
  {
    code: "professional",
    name: "Professional (3m)",
    description: "Duration: 84 days",
    price: 229,
    durationDays: 84,
  },
  {
    code: "enterprise",
    name: "Enterprise (6m)",
    description: "Duration: 168 days",
    price: 469,
    durationDays: 168,
  },
  {
    code: "lifetime",
    name: "GodLike (Lifetime)",
    description: "Duration: 69 years",
    price: 4999,
    durationDays: 25185,
  },
];

/**
 * Writes the catalogue into `premium_plans`.
 *
 * The upsert conflicts on `code`, so calling it on every startup keeps the
 * table in sync with the code without duplicating rows or resetting the
 * ids that `premium_transactions.plan_id` points at.
 *
 * It deliberately does **not** delete-and-reseed, the way Quotient's
 * `insert_plans()` does. A destructive reseed destroys the paid transactions
 * that reference the plan rows; an upsert leaves a plan that was removed
 * from the catalogue alone, so its transactions still resolve. The receipt
 * reads `plan_snapshot` anyway, so a reseed cannot break the payment page.
 */
export async function seedPremiumPlans(): Promise<void> {
  await db
    .insert(premiumPlans)
    .values(PREMIUM_PLAN_CATALOGUE)
    .onConflictDoUpdate({
      target: premiumPlans.code,
      set: {
        // `excluded` is the row that was about to be inserted.
        name: excluded(premiumPlans.name),
        description: excluded(premiumPlans.description),
        price: excluded(premiumPlans.price),
        durationDays: excluded(premiumPlans.durationDays),
        updatedAt: new Date(),
      },
    });
}
