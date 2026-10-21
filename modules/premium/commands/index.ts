/**
 * The premium commands.
 *
 * Two of them:
 *
 *  - `/premium` — the perks, generated from the free-tier configuration,
 *    and the one upgrade button (D29, D45);
 *  - `/premium-status` — the caller's own subscription and this server's
 *    entitlements, with the expiry timestamps.
 *
 * The files under `commands/premium/` are one-line re-exports of these.
 */

import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../../types/command.js";
import { listEntitlementRecords } from "../entitlements.js";
import { buildPerksEmbed, buildPremiumBuyRow, buildStatusEmbed } from "../gate.js";
import { getGuildSettings, getUserSettings } from "../repo.js";
import { FEATURE_LABELS } from "../types.js";

/**
 * `/premium` — what premium unlocks, and how to get it.
 *
 * The perk list is generated from the free-tier configuration, so it
 * cannot advertise a limit the code does not enforce.
 *
 * The reply is meant to be public: the perks are an advertisement, and a
 * feature nobody can see is a support ticket (D29, D43).
 */
export const premiumCommand: Command = {
  ephemeral: false,
  data: new SlashCommandBuilder()
    .setName("premium")
    .setDescription("See what premium unlocks and how to upgrade this server."),

  async execute(interaction) {
    await interaction.editReply({
      embeds: [buildPerksEmbed()],
      components: [buildPremiumBuyRow()],
    });
  },
};

/**
 * `/premium-status` — the caller's subscription and the server's
 * entitlements.
 *
 * The reply is ephemeral: it mixes the caller's own subscription with the
 * server's state, and the caller's own state is nobody else's business.
 */
export const premiumStatusCommand: Command = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("premium-status")
    .setDescription("Show your premium status and this server's entitlements."),

  async execute(interaction) {
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.editReply({
        content: "This command only works inside a server.",
      });

      return;
    }

    const [user, guild, entitlements] = await Promise.all([
      getUserSettings(interaction.user.id),
      getGuildSettings(guildId),
      listEntitlementRecords(guildId),
    ]);

    const userLines = [
      `> Active: ${user?.isPremium ? "**yes**" : "no"}`,
      `> Ends: ${formatExpiry(user?.premiumExpireTime ?? null)}`,
      `> Subscriptions bought: ${user?.premiums ?? 0}`,
    ].join("\n");

    const guildLines = [
      `> Subscription ends: ${formatExpiry(guild?.premiumExpiresAt ?? null)}`,
    ];

    if (guild?.madePremiumBy) {
      guildLines.push(`> Bought by: <@${guild.madePremiumBy}>`);
    }

    const entitlementLines =
      entitlements.length === 0
        ? ["> No entitlements yet. Run `/premium` to upgrade this server."]
        : entitlements.map((entitlement) => {
            const label = FEATURE_LABELS[entitlement.feature];
            const state = entitlement.active
              ? "✅ active"
              : entitlement.expired
                ? "⌛ expired"
                : "❌ off";

            return `> ${state} — **${label}** (${entitlement.feature}) until ${formatExpiry(entitlement.expiresAt)}`;
          });

    const embed = buildStatusEmbed({
      userLines,
      guildLines: guildLines.join("\n"),
      entitlementLines: entitlementLines.join("\n"),
    });

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * Renders an instant for a human.
 *
 * Discord's timestamp markup renders in each reader's own time zone; the
 * ISO timestamp is next to it so there is no doubt about the instant.
 */
function formatExpiry(date: Date | null): string {
  if (!date) return "never";

  return `<t:${Math.floor(date.getTime() / 1000)}:f> (\`${date.toISOString()}\`)`;
}
