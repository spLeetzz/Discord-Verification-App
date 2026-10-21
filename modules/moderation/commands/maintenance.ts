/**
 * `/maintenance` — hide the server from a role, and bring it back.
 *
 * Two Quotient bugs are fixed here:
 *
 *  1. `maintenance off` looked the maintenance channels up with
 *     `discord.utils.get(ctx.guild.channels, name="maintenance-chat")`,
 *     which asks a list for an attribute — so it never matched and the
 *     channels were never deleted. The channels are now deleted by the ids
 *     the bot recorded when it created them, and by nothing else: a
 *     moderator's own channel called `maintenance-chat` is not the bot's
 *     to delete.
 *  2. The unlock set `read_messages = True` unconditionally, which opened
 *     a channel that had been read-locked before the maintenance mode
 *     started. The previous state is recorded and restored exactly.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { formatActionReason } from "../reason.js";
import { channelsToHideForMaintenance, maintenanceOff, maintenanceOn } from "../lockdown.js";
import type { LockApplyResult, LockContext } from "../lockdown.js";
import {
  createMaintenanceChannels,
  deleteMaintenanceChannels,
  describeMaintenanceChannels,
} from "../maintenance.js";
import type { ModerationCommand } from "../types.js";
import { confirmAction } from "../views/confirm.js";
import { announcePanel, outcomePanel, replyPanel } from "../views/panels.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireGuild,
  requireMember,
  requireRoleOption,
  requireTextChannel,
  runCommand,
} from "./shared.js";

const maintenanceCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageChannels,
      missingPermission("manage_channels"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Hide the server from a role, and bring it back.")
    .addSubcommand((sub) =>
      sub
        .setName("on")
        .setDescription("Hide the channels from a role.")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("The role to hide the server from. Defaults to @everyone."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("off")
        .setDescription("Show the channels to a role again.")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("The role to show the server to. Defaults to @everyone."),
        ),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);
      const author = await requireMember(interaction);
      const channel = requireTextChannel(interaction);
      const subcommand = interaction.options.getSubcommand();
      const role =
        (await requireRoleOption(interaction)) ?? guild.roles.everyone;

      const reason = formatActionReason(author.displayName, author.id);

      const context: LockContext = {
        guild,
        author,
        reason,
        sourceChannelId: channel.id,
      };

      if (subcommand === "on") {
        const channels = channelsToHideForMaintenance(guild, role);

        if (channels.length === 0) {
          throw new InputError(
            `**${role.name}** has \`read_messages\` enabled in no channel I can edit.`,
          );
        }

        const confirmed = await confirmAction(interaction, {
          title: "Start maintenance",
          question: `\`${channels.length}\` channel${
            channels.length === 1 ? "" : "s"
          } have read messages enabled for **${role.name}**, and I can edit ${
            channels.length
          } of them.`,
          kind: "destructive",
          confirmLabel: "Start maintenance",
          footer: "The channels stay hidden until `/maintenance off`.",
        });

        if (!confirmed) {
          await replyPanel(
            interaction,
            outcomePanel({
              kind: "neutral",
              title: "Maintenance cancelled",
              description: "Nothing was hidden.",
              footer: "Run the command again when you are ready.",
            }),
          );
          return;
        }

        // The maintenance channels are created first so that their ids can
        // be recorded with the lockdown row. They are not hidden by the
        // mode that created them — `maintenanceOn` leaves them out of the
        // list of channels to hide.
        let maintenanceChannelIds: string[] = [];

        const createChannels = await confirmAction(interaction, {
          title: "Maintenance channels",
          question:
            "Do you want me to make the maintenance channels as well?",
          kind: "constructive",
          confirmLabel: "Create channels",
          footer:
            "The bot makes a `maintenance-chat` text channel and a " +
            "`maintenance-vc` voice channel.",
        });

        if (createChannels) {
          maintenanceChannelIds = await createMaintenanceChannels(
            guild,
            role,
            reason,
          );
        }

        let result: LockApplyResult;

        try {
          result = await maintenanceOn({
            context,
            role,
            maintenanceChannelIds,
          });
        } catch (error) {
          // The lockdown was refused, so no row was written and the ids of
          // the channels are recorded nowhere. They are removed again
          // rather than left behind as orphans.
          if (maintenanceChannelIds.length > 0) {
            await deleteMaintenanceChannels(
              guild,
              maintenanceChannelIds,
              reason,
            );
          }

          throw error;
        }

        const panel = outcomePanel({
          kind: "destructive",
          title: "Maintenance mode on",
          description: `Maintenance mode is on for **${role.name}**.`,
          fields: [
            { name: "Channels", value: String(result.locked), inline: true },
            ...(result.failed > 0
              ? [{ name: "Failed", value: String(result.failed), inline: true }]
              : []),
            ...(maintenanceChannelIds.length > 0
              ? [
                  {
                    name: "Maintenance channels",
                    value: String(maintenanceChannelIds.length),
                    inline: true,
                  },
                ]
              : []),
          ],
          footer: "Run `/maintenance off` to show the channels again.",
        });

        await announcePanel(channel, panel);

        await replyPanel(interaction, panel);

        return;
      }

      // The maintenance channels that are deleted are the ones the
      // lockdown recorded: the ids of the channels the bot created. The
      // record holds them, so they are read from the row and not from a
      // name — a channel that merely shares the name `maintenance-chat`
      // belongs to whoever made it.
      const result = await maintenanceOff({ context, role });

      const panel = outcomePanel({
        kind: "constructive",
        title: "Maintenance mode off",
        description: `Maintenance mode is off for **${role.name}**.`,
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
        footer: `The maintenance channels are gone. ${
          describeMaintenanceChannels(result.maintenanceChannels)
        }`,
      });

      await announcePanel(channel, panel);

      await replyPanel(interaction, panel);
    });
  },
};

export default maintenanceCommand;
