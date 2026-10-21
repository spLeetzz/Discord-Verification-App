/**
 * The free-tier allowances — one config object, read by every gate (D45).
 *
 * Quotient's `constants.perks` advertised limits the code did not enforce
 * (autorole: "1 free", easytags: "1 free"), and its perk table and its
 * socket perk list had drifted from each other. The table below is the
 * **code's** behaviour, not the marketing's:
 *
 * ```
 * freeTier: { scrims: 3, tourneys: 1, tagcheckChannels: 1, easytagChannels: 1,
 *             slotManagers: 1, ssverifyConfigs: 1, mediaPartners: 1,
 *             autopurgeChannels: 1 }
 * ```
 *
 * The perk list is generated from this object, so the two cannot disagree.
 * A gate for a thing with no entry here is **unlimited** — that is the
 * rule, and {@link freeTierLimit} returns `null` for it.
 *
 * Nothing may hard-code `3` or `1`: read the number from here.
 */

import { FEATURE_LABELS, PREMIUM_FEATURES } from "./types.js";

/**
 * How many of each thing a guild may have without paying.
 *
 * The numbers are the ones the ported code enforces. The perk list is
 * generated from them, so the advertised limit and the enforced limit are
 * the same number by construction.
 */
export const FREE_TIER = {
  /** Scrims a guild may have at once. */
  scrims: 3,
  /** Tournaments a guild may have at once. */
  tourneys: 1,
  /** Tag-check channels a guild may have. */
  tagcheckChannels: 1,
  /** Easy-tag channels a guild may have. */
  easytagChannels: 1,
  /** Slot managers a guild may have. */
  slotManagers: 1,
  /** Screenshot-verification setups a guild may have. */
  ssverifyConfigs: 1,
  /** Media-partner entries a guild may have. */
  mediaPartners: 1,
  /** Auto-purge channels a guild may have. */
  autopurgeChannels: 1,
} as const;

/** The names of the allowances in {@link FREE_TIER}. */
export type FreeTierKey = keyof typeof FREE_TIER;

/**
 * What each allowance is called in the perk list.
 *
 * The keys are the allowance names, so an allowance cannot be added without
 * also being given a name.
 */
export const FREE_TIER_LABELS: Record<FreeTierKey, string> = {
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
 * The free-tier limit for a thing.
 *
 * @param key the name of the allowance.
 * @returns the limit, or `null` when the thing has no allowance entry and
 *          is therefore unlimited.
 */
export function freeTierLimit(key: string): number | null {
  if (!Object.hasOwn(FREE_TIER, key)) return null;

  return FREE_TIER[key as FreeTierKey];
}

/**
 * The perk list, generated from the configuration.
 *
 * Two halves:
 *
 *  - the features premium unlocks, taken from the closed feature union;
 *  - the counts that stop being limits, taken from {@link FREE_TIER}.
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

  for (const key of Object.keys(FREE_TIER) as FreeTierKey[]) {
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
