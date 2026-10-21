/**
 * The free-tier allowances — one config object, read by every gate (D45).
 *
 * Quotient's `constants.perks` advertised limits the code did not enforce
 * (autorole: "1 free", easytags: "1 free"), and its perk table and its
 * socket perk list had drifted from each other. The table is the **code's**
 * behaviour, not the marketing's:
 *
 * ```
 * freeTier: { scrims: 3, tourneys: 1, tagcheckChannels: 1, easytagChannels: 1,
 *             slotManagers: 1, ssverifyConfigs: 1, mediaPartners: 1,
 *             autopurgeChannels: 1 }
 * ```
 *
 * **The table lives in `core/premium.ts` and is re-exported here.** It used
 * to be defined twice — once in `core/`, once here — with a test as the
 * only thing stopping the two copies from drifting. A documented invariant
 * that nothing enforces is worse than none, so there is now one table and
 * one place it is written down.
 *
 * `core/` is the lower layer: `modules/` may import from `core/`, never the
 * other way round, so the canonical table has to live there. This module
 * still owns what the core layer cannot: the **labels**, which are words
 * for people rather than for the compiler, and the perk list generated from
 * the table.
 *
 * The table is a **partial** record over the gated features: it has an
 * entry for the things the free tier caps and none for the ones it does
 * not. A feature with no entry is **unlimited** — that is the rule, and
 * {@link freeTierLimit} returns `null` for it.
 *
 * Nothing may hard-code `3` or `1`: read the number from here.
 */

import { FREE_TIER, freeTierLimit } from "../../core/premium.js";
import type { FreeTierKey, FreeTierLimits } from "../../core/premium.js";
import { FEATURE_LABELS, PREMIUM_FEATURES } from "./types.js";

export { FREE_TIER, freeTierLimit };
export type { FreeTierKey };

/**
 * The gated things the free tier actually caps.
 *
 * {@link FreeTierKey} names **every** gated feature, so it is wider than
 * the table: the features the free tier does not cap have no entry in it
 * and are unlimited. The keys the table has an entry for are the ones an
 * allowance can be read for, and the ones the perk list is generated from.
 *
 * The table types the capped features with their exact number and the
 * uncapped ones as `undefined`, so this is the set of keys that do not
 * read as `undefined`.
 */
export type CappedFreeTierKey = {
  [K in keyof FreeTierLimits]-?: undefined extends FreeTierLimits[K]
    ? never
    : K;
}[keyof FreeTierLimits];

/**
 * What each allowance is called in the perk list.
 *
 * The keys are the allowances the table caps, so an allowance cannot be
 * added without also being given a name: the record type makes the
 * compiler say so.
 */
export const FREE_TIER_LABELS: Record<CappedFreeTierKey, string> = {
  scrims: "scrims",
  tourneys: "tournaments",
  tagcheckChannels: "tag-check channels",
  easytagChannels: "easy-tag channels",
  slotManagers: "slot managers",
  ssverifyConfigs: "screenshot verification setups",
  mediaPartners: "media partners",
  autopurgeChannels: "auto-purge channels",
};

/**
 * The perk list, generated from the configuration.
 *
 * Two halves:
 *
 *  - the features premium unlocks, taken from the closed feature union;
 *  - the counts that stop being limits, taken from {@link FREE_TIER}.
 *
 * Only the capped things are in the second half: the features the free
 * tier does not cap are unlimited already, so there is no count to say.
 *
 * Quotient's list advertised "Access to the Quotient Pro bot", a second
 * bot application that does not exist in the source repository (D40). The
 * perk premium actually sells is the entitlement list, so that is what is
 * advertised.
 */
export function buildPerkLines(): string[] {
  const lines: string[] = [];

  for (const feature of PREMIUM_FEATURES) {
    lines.push(`✅ ${FEATURE_LABELS[feature]}`);
  }

  for (const key of Object.keys(FREE_TIER) as CappedFreeTierKey[]) {
    lines.push(
      `✅ Unlimited ${FREE_TIER_LABELS[key]} (free tier: ${FREE_TIER[key]})`,
    );
  }

  return lines;
}

/**
 * The perk list as one block of text.
 *
 * Used by the perks embed and by the gate embed, so both say the same
 * thing.
 */
export function buildPerkText(): string {
  return buildPerkLines().join("\n");
}
