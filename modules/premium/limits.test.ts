/**
 * The free-tier allowances (D45) and the perk list they generate.
 *
 * The point of the test is that the **table and the code cannot
 * disagree**. Quotient's `constants.perks` advertised limits the code
 * did not enforce, and its perk table and its socket perk list had
 * drifted from each other. Here the perk list is generated from the one
 * configuration object, and this test proves it.
 *
 * The table used to live in two places — `core/premium.ts` and
 * `modules/premium/limits.ts` — with a test comparing the two copies.
 * That test guarded the *copies*, not the business rule: it could only
 * say "these two lists agree", never "this is the limit a user gets".
 * There is one table now, and the test pins **the numbers**, which is
 * what every area of the codebase reads.
 */

import { describe, expect, it } from "vitest";
import { ENTITLEMENT_FEATURES } from "../../db/schema/common.js";
import { PremiumFeature } from "../../core/constants.js";
import { FREE_TIER as CORE_FREE_TIER } from "../../core/premium.js";
import {
  buildPerkLines,
  buildPerkText,
  freeTierLimit,
  FREE_TIER,
  FREE_TIER_LABELS,
} from "./limits.js";
import type { CappedFreeTierKey } from "./limits.js";
import { FEATURE_LABELS, PREMIUM_FEATURES } from "./types.js";

/**
 * The keys the table has an entry for.
 *
 * The table is a partial record over the gated features, so this is the
 * allowances the free tier caps — and the ones the perk list is built
 * from.
 */
const CAPPED_KEYS = Object.keys(FREE_TIER) as CappedFreeTierKey[];

describe("modules/premium/limits — the free tier", () => {
  it("has the limits the code enforces", () => {
    // These are the real caps, not the ones the old perk table
    // advertised. They are business data: every area reads them, so a
    // refactor that quietly changed a number would change what a user
    // gets, and this is the test that says so.
    expect(FREE_TIER).toEqual({
      scrims: 3,
      tourneys: 1,
      tagcheckChannels: 1,
      easytagChannels: 1,
      slotManagers: 1,
      ssverifyConfigs: 1,
      mediaPartners: 1,
      autopurgeChannels: 1,
    });
  });

  it("is the canonical table, not a copy of it", () => {
    // `core/premium.ts` owns the table; this module re-exports it. The
    // check is identity, not equality: a copy would have the same numbers
    // and still be a second thing to keep in step.
    expect(FREE_TIER).toBe(CORE_FREE_TIER);
  });

  it("reads a limit by name", () => {
    expect(freeTierLimit("scrims")).toBe(3);
    expect(freeTierLimit("tourneys")).toBe(1);
  });

  it("treats a gated thing with no allowance entry as unlimited", () => {
    // The table is a partial record over the gated features: the ones
    // the free tier does not cap have no entry in it, and no entry
    // means no limit.
    expect(Object.hasOwn(FREE_TIER, "slotReminders")).toBe(false);
    expect(freeTierLimit("slotReminders")).toBeNull();
    expect(freeTierLimit("idpTransfer")).toBeNull();
    expect(freeTierLimit("screenshotTypes")).toBeNull();
    expect(freeTierLimit("successMessage")).toBeNull();
  });

  it("has a label for every allowance", () => {
    for (const key of CAPPED_KEYS) {
      expect(FREE_TIER_LABELS[key]).toBeTruthy();
    }
  });
});

describe("modules/premium/limits — the perk list", () => {
  it("is generated from the configuration", () => {
    const lines = buildPerkLines();
    const text = buildPerkText();

    for (const key of CAPPED_KEYS) {
      const limit = FREE_TIER[key];

      // Every allowance appears, with the number the gate enforces.
      expect(text).toContain(`${FREE_TIER_LABELS[key]} (free tier: ${limit})`);
    }

    expect(lines.length).toBe(
      Object.keys(FREE_TIER).length + PREMIUM_FEATURES.length,
    );
  });

  it("lists every feature premium unlocks", () => {
    const text = buildPerkText();

    for (const feature of PREMIUM_FEATURES) {
      expect(text).toContain(FEATURE_LABELS[feature]);
    }
  });

  it("does not advertise the Pro bot", () => {
    // Quotient's list promised "Access to the Quotient Pro bot", a
    // second bot application that does not exist in the source (D40).
    expect(buildPerkText().toLowerCase()).not.toContain("pro bot");
  });
});

describe("modules/premium/types — the feature union", () => {
  it("is the list the database constraint is generated from", () => {
    expect(PREMIUM_FEATURES).toEqual([...ENTITLEMENT_FEATURES]);
  });

  it("is the list the runtime union holds", () => {
    // `core/constants.ts` is where the runtime `PremiumFeature` union
    // lives. The schema's list and that union have to be the same set.
    expect(Object.values(PremiumFeature).sort()).toEqual(
      [...ENTITLEMENT_FEATURES].sort(),
    );
  });

  it("has a label for every feature", () => {
    for (const feature of PREMIUM_FEATURES) {
      expect(FEATURE_LABELS[feature]).toBeTruthy();
    }
  });
});
