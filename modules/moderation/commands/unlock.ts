/**
 * `/unlock` — lift a lockdown.
 *
 * The unlock puts the channel's permissions back the way they were, not
 * the way Quotient did it: Quotient set `send_messages = True`
 * unconditionally, which opened a channel that had been write-locked
 * before the lockdown.
 */

import { SlashCommandBuilder } from "discord.js";
import { formatActionReason } from "../reason.js";
import { unlockChannel, unlockServer } from "../lockdown.js";
import type { LockContext } from "../lockdown.js";
import type { ModerationCommand } from "../types.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireGuild,
  requireMember,
  requireTextChannel,
  resolveLockableChannel,
  runCommand,
} from "./shared.js";

const unlockCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageChannels,
      missingPermission("manage_channels"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Lift a lockdown.")
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Unlock one channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to unlock. Defaults to this one."),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("server").setDescription("Unlock every locked channel."),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);
      const author = await requireMember(interaction);
      const channel = requireTextChannel(interaction);
      const subcommand = interaction.options.getSubcommand();

      const context: LockContext = {
        guild,
        author,
        reason: formatActionReason(author.displayName, author.id),
        sourceChannelId: channel.id,
      };

      if (subcommand === "server") {
        const result = await unlockServer(context);

        await channel.send(
          `Unlocked ${result.restored} channel${result.restored === 1 ? "" : "s"}.` +
            (result.failed > 0 ? ` (Failed: ${result.failed})` : "") +
            (result.withoutRecord > 0
              ? ` (${result.withoutRecord} had no record of their previous permissions and were reset to inherit.)`
              : ""),
        );

        await interaction.editReply({
          content: `Unlocked ${result.restored} channel${result.restored === 1 ? "" : "s"}.`,
        });

        return;
      }

      const target = await resolveLockableChannel(interaction, "channel");
      const result = await unlockChannel({ context, channel: target });

      await channel.send(
        `Unlocked **${target.name}**.` +
          (result.withoutRecord > 0
            ? " (Its previous permissions were not recorded, so it was reset to inherit.)"
            : ""),
      );

      await interaction.editReply({
        content: `Unlocked **${target.name}**.`,
      });
    });
  },
};

export default unlockCommand;
