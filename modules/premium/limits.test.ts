/**
 * The free-tier allowances (D45) and the perk list they generate.
 *
 * The point of the test is that the **table and the code cannot
 * disagree**. Quotient's `constants.perks` advertised limits the code
 * did not enforce, and its perk table and its socket perk list had
 * drifted from each other. Here the perk list is generated from the one
 * configuration object, and this test proves it.
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
import { FEATURE_LABELS, PREMIUM_FEATURES } from "./types.js";

describe("modules/premium/limits — the free tier", () => {
  it("has the limits the code enforces", () => {
    // These are the real caps, not the ones the old perk table
    // advertised.
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

  it("reads a limit by name", () => {
    expect(freeTierLimit("scrims")).toBe(3);
    expect(freeTierLimit("tourneys")).toBe(1);
  });

  it("treats a thing with no allowance entry as unlimited", () => {
    expect(freeTierLimit("snipes")).toBeNull();
    expect(freeTierLimit("")).toBeNull();
  });

  it("has a label for every allowance", () => {
    for (const key of Object.keys(FREE_TIER) as (keyof typeof FREE_TIER)[]) {
      expect(FREE_TIER_LABELS[key]).toBeTruthy();
    }
  });

  it("matches the copy of the table in core", () => {
    // `core/premium.ts` carries a second copy of this table. It is not
    // the canonical one — `modules/premium/limits.ts` is — but the two
    // must not drift, so this test fails the moment they do.
    expect(CORE_FREE_TIER).toEqual(FREE_TIER);
  });
});

describe("modules/premium/limits — the perk list", () => {
  it("is generated from the configuration", () => {
    const lines = buildPerkLines();
    const text = buildPerkText();

    for (const key of Object.keys(FREE_TIER) as (keyof typeof FREE_TIER)[]) {
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
