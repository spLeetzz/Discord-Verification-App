/**
 * The gate presentation (D29).
 *
 * Quotient had **four** different ways of refusing a premium feature: a
 * rich upsell embed (6 sites), a hard-coded string (12 sites), an
 * exception carrying an uninterpolated `{ctx.bot.prime_link}` placeholder
 * (2 sites), and a **silently disabled button with no explanation** (1
 * site). Only 6 of 25 gates gave the user a clickable upgrade button.
 *
 * There is one presentation here: {@link buildPremiumGateEmbed} and one
 * button. Every gate uses both. The silently-disabled button is banned —
 * a feature the user cannot discover is a support ticket, not a business
 * model.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { makeCustomId } from "../../core/custom-id.js";
import { buildPerkLines } from "./limits.js";
import { FEATURE_LABELS } from "./types.js";
import type { PremiumFeature } from "./types.js";

/** The module prefix every premium custom id carries. */
export const PREMIUM_MODULE = "premium";

/** The action of the buy button. */
export const PREMIUM_BUY_ACTION = "buy";

/** The custom id of the one and only upgrade button. */
export const PREMIUM_BUY_CUSTOM_ID = makeCustomId(
  PREMIUM_MODULE,
  PREMIUM_BUY_ACTION,
);

/** The accent colour the premium embeds use. */
export const PREMIUM_EMBED_COLOR = 0x00ffb3;

/**
 * The refusal a gate shows, with the feature named and the upgrade path
 * spelled out.
 *
 * The same text {@link assertEntitled} puts in its `DenialError`, so a
 * gate that throws and a gate that renders say the same thing.
 */
export function gateReason(feature: PremiumFeature): string {
  const label = FEATURE_LABELS[feature];

  return `**${label}** is a premium feature, and this server does not hold the \`${feature}\` entitlement. Run \`/premium\` to upgrade this server and unlock it.`;
}

/**
 * The embed every premium gate shows.
 *
 * @param reason why the feature is being refused. It must name the
 *               feature and the way out — `gateReason(feature)` does
 *               both.
 */
export function buildPremiumGateEmbed(reason: string): EmbedBuilder {
  const perks = buildPerkLines()
    .map((line) => `• ${line}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("🔒 Premium feature")
    .setDescription(
      [
        reason,
        "",
        "**What premium unlocks**",
        perks,
        "",
        "Run `/premium` to upgrade this server.",
      ].join("\n"),
    )
    .setColor(PREMIUM_EMBED_COLOR);
}

/**
 * The one and only upgrade button.
 *
 * @param label the button's text.
 */
export function buildPremiumBuyButton(
  label = "Upgrade to Premium",
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(PREMIUM_BUY_CUSTOM_ID)
    .setLabel(label)
    .setEmoji("💎")
    .setStyle(ButtonStyle.Primary);
}

/**
 * The button in an action row, ready to be sent.
 */
export function buildPremiumBuyRow(
  label?: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildPremiumBuyButton(label),
  );
}

/**
 * The status embed, shown by `/premium-status`.
 *
 * @param userLines        the caller's own subscription.
 * @param guildLines       the server's subscription.
 * @param entitlementLines one line per feature entitlement.
 */
export function buildStatusEmbed(sections: {
  userLines: string;
  guildLines: string;
  entitlementLines: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("💎 Premium status")
    .addFields(
      { name: "Your subscription", value: sections.userLines, inline: false },
      { name: "This server", value: sections.guildLines, inline: false },
      {
        name: "Entitlements",
        value: sections.entitlementLines,
        inline: false,
      },
    )
    .setColor(PREMIUM_EMBED_COLOR);
}

/**
 * A gate, ready to send.
 *
 * The embed and the button travel together, so a gate cannot show the
 * refusal without the upgrade path. A refusal with no way forward is the
 * "silently disabled button" this decision bans.
 */
export interface PremiumGate {
  readonly embed: EmbedBuilder;
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * The gate, ready to send.
 *
 * ```ts
 * const gate = buildPremiumGate(gateReason(PremiumFeature.scrimSlots));
 * await interaction.editReply({ embeds: [gate.embed], components: gate.components });
 * ```
 */
export function buildPremiumGate(reason: string): PremiumGate {
  return {
    embed: buildPremiumGateEmbed(reason),
    components: [buildPremiumBuyRow()],
  };
}

/**
 * The perks embed, shown by `/premium`.
 *
 * The list is generated from the free-tier configuration, so what the
 * embed advertises and what the code enforces cannot drift apart.
 */
export function buildPerksEmbed(): EmbedBuilder {
  const perks = buildPerkLines()
    .map((line) => `• ${line}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("💎 Premium")
    .setDescription(
      [
        "Premium lifts the free-tier limits and unlocks the features below.",
        "",
        perks,
        "",
        "Use the button below to start a purchase.",
      ].join("\n"),
    )
    .setColor(PREMIUM_EMBED_COLOR);
}
