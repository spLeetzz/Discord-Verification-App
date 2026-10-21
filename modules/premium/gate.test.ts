/**
 * The gate presentation (D29).
 *
 * Quotient had four different ways of refusing a premium feature and
 * only 6 of 25 gates gave the user a clickable upgrade button. The
 * property worth protecting here is simple: **there is one presentation,
 * and it always comes with the button.**
 */

import { describe, expect, it } from "vitest";
import { parseCustomId } from "../../core/custom-id.js";
import {
  buildPremiumGate,
  buildPremiumGateEmbed,
  buildPremiumBuyButton,
  buildPremiumBuyRow,
  gateReason,
  PREMIUM_BUY_CUSTOM_ID,
  PREMIUM_MODULE,
} from "./gate.js";
import { PremiumFeature } from "../../core/constants.js";

/**
 * The custom id of a built button, wherever it is hiding.
 */
function customIdOf(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "custom_id" in value &&
    typeof (value as { custom_id?: unknown }).custom_id === "string"
  ) {
    return (value as { custom_id: string }).custom_id;
  }

  const components = (value as { components?: unknown[] } | null)?.components;

  if (!Array.isArray(components)) return undefined;

  return customIdOf(components[0]);
}

describe("modules/premium/gate", () => {
  it("uses one custom id for the upgrade button", () => {
    expect(PREMIUM_BUY_CUSTOM_ID).toBe("premium:buy");
  });

  it("routes the upgrade button back to this module", () => {
    const parsed = parseCustomId(PREMIUM_BUY_CUSTOM_ID);

    expect(parsed?.type).toBe(PREMIUM_MODULE);
    expect(parsed?.action).toBe("buy");
  });

  it("names the feature and the upgrade path in the reason", () => {
    const reason = gateReason(PremiumFeature.scrimSlots);

    expect(reason).toContain(PremiumFeature.scrimSlots);
    expect(reason).toContain("/premium");
  });

  it("shows the reason in the embed", () => {
    const reason = gateReason(PremiumFeature.idpTransfer);
    const embed = buildPremiumGateEmbed(reason);

    expect(embed.data.description).toContain(reason);
  });

  it("lists the perks in the embed", () => {
    const embed = buildPremiumGateEmbed("Because.");

    expect(embed.data.description).toContain("Extra scrim slots");
    expect(embed.data.description).toContain("Unlimited scrims");
  });

  it("always ships the upgrade button with the refusal", () => {
    const gate = buildPremiumGate("Because.");

    expect(gate.components).toHaveLength(1);
    expect(customIdOf(gate.components[0]?.toJSON())).toBe(PREMIUM_BUY_CUSTOM_ID);
  });

  it("builds the one button everywhere", () => {
    const button = buildPremiumBuyButton();
    const row = buildPremiumBuyRow();

    expect(customIdOf(button.toJSON())).toBe(PREMIUM_BUY_CUSTOM_ID);
    expect(customIdOf(row.toJSON())).toBe(PREMIUM_BUY_CUSTOM_ID);
  });
});