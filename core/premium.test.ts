/**
 * The free-tier table and the lookup that reads it (D45).
 *
 * Two things are pinned here. The first is the **numbers**: they are
 * business data, every area of the codebase reads them, and a
 * refactor that quietly changed one would change what a user gets. The
 * second is the **lookup**: a feature the table has an entry for
 * answers with its limit, and a feature it has no entry for answers
 * with `null` — the way "unlimited" is spelled.
 *
 * The second one used to be unreachable. The key type was the set of
 * keys the table happened to contain, so every key carried a limit and
 * the unlimited branch could never be taken. The key type is now the
 * set of *gated features*, and the table is a partial record over it.
 */

import { describe, expect, it } from "vitest";
import {
  FREE_TIER,
  FREE_TIER_FEATURES,
  freeTierLimit,
} from "./premium.js";
import type { FreeTierKey } from "./premium.js";

/**
 * The features the table caps.
 *
 * `satisfies` checks that every name is a gated feature, so a typo
 * would not compile; the test below pins which of them the table
 * actually has an entry for.
 */
const CAPPED = [
  "scrims",
  "tourneys",
  "tagcheckChannels",
  "easytagChannels",
  "slotManagers",
  "ssverifyConfigs",
  "mediaPartners",
  "autopurgeChannels",
] as const satisfies readonly FreeTierKey[];

/**
 * The gated features the table says nothing about.
 *
 * Typed as {@link FreeTierKey}, so these are real gated features and
 * not typos: "unlimited" is a property of a feature, not of a missing
 * name.
 */
const UNLIMITED = [
  "slotReminders",
  "idpTransfer",
  "screenshotTypes",
  "successMessage",
] as const satisfies readonly FreeTierKey[];

describe("core/premium — the free-tier table", () => {
  it("holds the limits the code enforces", () => {
    // The exact numbers, one by one. A limit that moves is a business
    // change, not a refactor.
    expect(FREE_TIER.scrims).toBe(3);
    expect(FREE_TIER.tourneys).toBe(1);
    expect(FREE_TIER.tagcheckChannels).toBe(1);
    expect(FREE_TIER.easytagChannels).toBe(1);
    expect(FREE_TIER.slotManagers).toBe(1);
    expect(FREE_TIER.ssverifyConfigs).toBe(1);
    expect(FREE_TIER.mediaPartners).toBe(1);
    expect(FREE_TIER.autopurgeChannels).toBe(1);
  });

  it("has no other entries", () => {
    expect(Object.keys(FREE_TIER)).toEqual([...CAPPED]);
  });

  it("caps exactly the features the type declares", () => {
    // The runtime and the type have to agree on which features carry a
    // limit. `Object.keys` is what the perk list is generated from, so
    // a feature that gained a table entry by accident would show up
    // in the advertisement too.
    const capped = FREE_TIER_FEATURES.filter(
      (feature) => freeTierLimit(feature) !== null,
    );

    expect([...capped]).toEqual([...CAPPED]);
  });
});

describe("core/premium — freeTierLimit", () => {
  it("reads the limit of a capped feature", () => {
    expect(freeTierLimit("scrims")).toBe(3);
    expect(freeTierLimit("tourneys")).toBe(1);
    expect(freeTierLimit("tagcheckChannels")).toBe(1);
    expect(freeTierLimit("easytagChannels")).toBe(1);
    expect(freeTierLimit("slotManagers")).toBe(1);
    expect(freeTierLimit("ssverifyConfigs")).toBe(1);
    expect(freeTierLimit("mediaPartners")).toBe(1);
    expect(freeTierLimit("autopurgeChannels")).toBe(1);
  });

  it("reads a feature with no entry as unlimited", () => {
    // The case the old key type could not express: a gated feature the
    // table has no entry for. `null` is how "unlimited" is spelled.
    for (const feature of UNLIMITED) {
      expect(freeTierLimit(feature)).toBeNull();
    }
  });

  it("answers every gated feature", () => {
    // Every feature gets one of the two answers, and no other: a limit
    // or "unlimited", never a third thing.
    for (const feature of FREE_TIER_FEATURES) {
      const limit = freeTierLimit(feature);

      expect(limit === null || typeof limit === "number").toBe(true);
    }
  });
});
