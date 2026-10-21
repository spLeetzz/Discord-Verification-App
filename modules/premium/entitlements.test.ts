/**
 * The entitlement gate, proved against the live database.
 *
 * The properties that matter (D15):
 *
 *  - an enabled, unexpired entitlement is allowed;
 *  - an entitlement with no expiry never lapses;
 *  - an **expired** entitlement is refused **even though no sweep has
 *    run** — the expiry is evaluated at read time, not by a timer;
 *  - a disabled entitlement is refused;
 *  - an unknown feature is refused;
 *  - an expired entitlement is **inactive, not deleted**: the row stays
 *    and the guild's configuration is untouched.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { guildEntitlements } from "../../db/schema.js";
import { DenialError } from "../../utils/errors.js";
import {
  assertEntitled,
  entitlementLookup,
  getEntitlementRecord,
  isEntitled,
  isEntitlementActive,
} from "./entitlements.js";
import { upsertEntitlement } from "./repo.js";
import type { PremiumFeature } from "./types.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `premium-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const FEATURE: PremiumFeature = "scrim_slots";

beforeEach(async () => {
  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);
});

afterAll(async () => {
  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

  await closeDatabase();
});

describe("modules/premium/entitlements — assertEntitled", () => {
  it("allows a guild that holds the feature", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      source: "premium",
    });

    await expect(assertEntitled(GUILD_ID, FEATURE)).resolves.toBeUndefined();
  });

  it("allows an entitlement that never expires", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: null,
      source: "owner",
    });

    await expect(assertEntitled(GUILD_ID, FEATURE)).resolves.toBeUndefined();
  });

  it("refuses an expired entitlement even though no sweep has run", async () => {
    // The row still says `enabled`. Nothing cleared it. The expiry is
    // evaluated when the row is read, so the gate refuses anyway.
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: new Date(Date.now() - 60_000),
      source: "premium",
    });

    await expect(assertEntitled(GUILD_ID, FEATURE)).rejects.toThrow(DenialError);
  });

  it("refuses a disabled entitlement", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: false,
      expiresAt: new Date(Date.now() + 60_000),
      source: "premium",
    });

    await expect(assertEntitled(GUILD_ID, FEATURE)).rejects.toThrow(DenialError);
  });

  it("refuses a guild that never held the feature", async () => {
    await expect(assertEntitled(GUILD_ID, FEATURE)).rejects.toThrow(DenialError);
  });

  it("refuses a feature nobody has heard of", async () => {
    // The union is closed at compile time; at runtime an unknown feature
    // simply has no row, so it is refused rather than allowed.
    const unknown = "not_a_feature" as PremiumFeature;

    await expect(assertEntitled(GUILD_ID, unknown)).rejects.toThrow(DenialError);
  });

  it("names the feature and the upgrade path in the refusal", async () => {
    const error = await assertEntitled(GUILD_ID, FEATURE).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DenialError);
    expect((error as Error).message).toContain(FEATURE);
    expect((error as Error).message).toContain("/premium");
  });

  it("does not delete the row when the entitlement expires", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: new Date(Date.now() - 60_000),
      source: "premium",
    });

    await assertEntitled(GUILD_ID, FEATURE).catch(() => undefined);

    const [row] = await db
      .select({ enabled: guildEntitlements.enabled })
      .from(guildEntitlements)
      .where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

    // The row is still there. A lapsed subscription stops selling; it
    // does not destroy what the customer configured (D15).
    expect(row?.enabled).toBe(true);
  });
});

describe("modules/premium/entitlements — the expiry rule", () => {
  it("is active when it is enabled and unexpired", () => {
    expect(
      isEntitlementActive({
        guildId: GUILD_ID,
        feature: FEATURE,
        enabled: true,
        expiresAt: new Date(Date.now() + 60_000),
        source: "premium",
      }),
    ).toBe(true);
  });

  it("is active when it has no expiry", () => {
    expect(
      isEntitlementActive({
        guildId: GUILD_ID,
        feature: FEATURE,
        enabled: true,
        expiresAt: null,
        source: "premium",
      }),
    ).toBe(true);
  });

  it("is inactive when it is disabled", () => {
    expect(
      isEntitlementActive({
        guildId: GUILD_ID,
        feature: FEATURE,
        enabled: false,
        expiresAt: null,
        source: "premium",
      }),
    ).toBe(false);
  });

  it("is inactive the moment it expires, not a second later", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(
      isEntitlementActive(
        {
          guildId: GUILD_ID,
          feature: FEATURE,
          enabled: true,
          expiresAt: new Date(now.getTime() + 1),
          source: "premium",
        },
        now,
      ),
    ).toBe(true);

    expect(
      isEntitlementActive(
        {
          guildId: GUILD_ID,
          feature: FEATURE,
          enabled: true,
          expiresAt: now,
          source: "premium",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("modules/premium/entitlements — the lookup", () => {
  it("answers the boolean question the guards ask", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      source: "premium",
    });

    expect(await isEntitled(GUILD_ID, FEATURE)).toBe(true);
    expect(await entitlementLookup.isEntitled(GUILD_ID, FEATURE)).toBe(true);
    expect(await entitlementLookup.isEntitled(GUILD_ID, "idp_transfer")).toBe(
      false,
    );
  });

  it("reports an expired entitlement as inactive", async () => {
    await upsertEntitlement({
      guildId: GUILD_ID,
      feature: FEATURE,
      enabled: true,
      expiresAt: new Date(Date.now() - 1),
      source: "premium",
    });

    const record = await getEntitlementRecord(GUILD_ID, FEATURE);

    expect(record?.enabled).toBe(true);
    expect(record?.active).toBe(false);
    expect(record?.expired).toBe(true);
  });
});
