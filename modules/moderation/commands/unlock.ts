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
import { announcePanel, outcomePanel, replyPanel } from "../views/panels.js";
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

        const panel = outcomePanel({
          kind: "constructive",
          title: "Server unlocked",
          description: `Unlocked ${result.restored} channel${
            result.restored === 1 ? "" : "s"
          }.`,
          fields: [
            { name: "Restored", value: String(result.restored), inline: true },
            ...(result.failed > 0
              ? [{ name: "Failed", value: String(result.failed), inline: true }]
              : []),
            ...(result.withoutRecord > 0
              ? [
                  {
                    name: "Reset to inherit",
                    value: String(result.withoutRecord),
                    inline: true,
                  },
                ]
              : []),
          ],
          footer:
            result.withoutRecord > 0
              ? "The channels without a record were reset to inherit."
              : "The channels are back the way they were before the lockdown.",
        });

        await announcePanel(channel, panel);

        await replyPanel(interaction, panel);

        return;
      }

      const target = await resolveLockableChannel(interaction, "channel");
      const result = await unlockChannel({ context, channel: target });

      const panel = outcomePanel({
        kind: "constructive",
        title: "Channel unlocked",
        description: `Unlocked **${target.name}**.`,
        fields:
          result.withoutRecord > 0
            ? [
                {
                  name: "Reset to inherit",
                  value: String(result.withoutRecord),
                  inline: true,
                },
              ]
            : [],
        footer:
          result.withoutRecord > 0
            ? "Its previous permissions were not recorded, so it was reset to inherit."
            : "The channel is back the way it was before the lockdown.",
      });

      await announcePanel(channel, panel);

      await replyPanel(interaction, panel);
    });
  },
};

export default unlockCommand;
