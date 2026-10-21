/**
 * The `/tourney create` subcommand.
 *
 * Starts the setup wizard. The wizard is a panel with a button per
 * field; each field is a **modal** or a **select menu** (D17).
 *
 * The free-tier allowance is read from the allowance table (D45) — never
 * hard-coded.
 */

import { SlashCommandSubcommandBuilder } from "discord.js";
import { FREE_TIER } from "../../../modules/premium/limits.js";
import { FEATURE_LABELS } from "../../../modules/premium/types.js";
import { PremiumFeature } from "../../../core/constants.js";
import { isEntitled } from "../../premium/entitlements.js";
import { canUseTourneyMod } from "../guards.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { buildWizardPanel, wizardStore } from "../views/wizard.js";
import type { TourneySubcommand } from "./types.js";

/** How many tournaments a guild may have without paying. */
export const FREE_TOURNEY_LIMIT = FREE_TIER.tourneys;

/** The subcommand. */
export const createSubcommand: TourneySubcommand = {
  data: new SlashCommandSubcommandBuilder()
    .setName("create")
    .setDescription("Create a tournament with the setup wizard."),

  async run(interaction) {
    const refusal = await canUseTourneyMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    // The free-tier allowance, not a hard-coded one (D45).
    //
    // The gate is the **tournament** entitlement, not the scrim one:
    // scrims and tournaments are separate features, and a guild that
    // bought extra scrim slots has not bought extra tournaments.
    if (!(await isEntitled(guildId, PremiumFeature.tourneyFeatures))) {
      const current = await repo.countTourneys(guildId);

      if (current >= FREE_TOURNEY_LIMIT) {
        // The feature is named with the premium module's own label, so
        // the refusal here and the refusal a gate throws read alike.
        const label = FEATURE_LABELS[PremiumFeature.tourneyFeatures];

        await interaction.editReply({
          content: `You can only have ${FREE_TOURNEY_LIMIT} tournament(s) on this server without the **${label}** entitlement. You already have ${current}.`,
        });

        return;
      }
    }

    const draft = service.newDraft(guildId, interaction.user.id);
    const token = wizardStore.issue(draft);

    const panel = buildWizardPanel(draft, token);

    await interaction.editReply({
      embeds: panel.embeds,
      components: panel.components,
    });
  },
};
