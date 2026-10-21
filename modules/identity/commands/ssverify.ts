/**
 * `/ssverify` — the screenshot-verification panel.
 *
 * One command, one panel. The panel itself lives in `../views/ssmod.ts`;
 * this file only opens it.
 *
 * The reply is **ephemeral**. The panel is a moderator's control panel:
 * its buttons delete a server's verification setup, repoint the channel
 * the bot reads, change the role the bot grants and set the text the bot
 * posts. It does not belong in the channel.
 *
 * The ephemeral reply is not the authorisation — a message that only the
 * moderator can see still travels, and the panel's buttons check the
 * caller themselves (`../views/ssmod.ts`). The reply is hidden because a
 * moderator's control panel is not the channel's business.
 */

import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { replyError } from "../../../core/context.js";
import { hasGuildPermissions } from "../../../core/guards.js";
import type { Command } from "../../../types/command.js";
import { errorMessage } from "../../../utils/errors.js";
import * as service from "../service.js";
import { buildSsListPanel } from "../views/ssmod.js";

/** The command object. */
export const ssVerifyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ssverify")
    .setDescription(
      "Set up a channel where participants verify themselves with screenshots.",
    ),

  /** Only the moderator who ran the command sees the panel. */
  ephemeral: true,

  async execute(interaction) {
    if (!(await hasGuildPermissions(interaction, PermissionFlagsBits.ManageGuild))) {
      await replyError(
        interaction,
        "You need the **Manage Server** permission to use this command.",
      );

      return;
    }

    const guildId = interaction.guildId;

    if (!guildId) {
      await replyError(interaction, "This command only works in a server.");

      return;
    }

    try {
      const configs = await service.listSsConfigs(guildId);

      const panel = buildSsListPanel(configs);

      await interaction.editReply({
        embeds: [panel.embed],
        components: panel.components,
      });
    } catch (error) {
      await replyError(interaction, errorMessage(error));
    }
  },
};
