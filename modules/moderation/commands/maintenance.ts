/**
 * `/maintenance` — hide the server from a role, and bring it back.
 *
 * Two Quotient bugs are fixed here:
 *
 *  1. `maintenance off` looked the maintenance channels up with
 *     `discord.utils.get(ctx.guild.channels, name="maintenance-chat")`,
 *     which asks a list for an attribute — so it never matched and the
 *     channels were never deleted. The channels are now found by a name
 *     predicate, and by the ids the bot recorded when it created them.
 *  2. The unlock set `read_messages = True` unconditionally, which opened
 *     a channel that had been read-locked before the maintenance mode
 *     started. The previous state is recorded and restored exactly.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { plural } from "../../../core/text.js";
import { formatActionReason } from "../reason.js";
import { channelsToHideForMaintenance, maintenanceOff, maintenanceOn } from "../lockdown.js";
import type { LockContext } from "../lockdown.js";
import {
  createMaintenanceChannels,
  deleteMaintenanceChannels,
} from "../maintenance.js";
import { findLockdown, findLockdownJob } from "../repo.js";
import type { ModerationCommand } from "../types.js";
import { prompt } from "../../../core/prompt.js";
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

        const confirmed = await prompt(
          interaction,
          `**Do you want me to continue?**\n\`${channels.length}\` channel${channels.length === 1 ? "" : "s"} have read messages enabled for **${role.name}**, and I can edit ${channels.length} of them.`,
        );

        if (!confirmed) {
          await interaction.editReply({ content: "Alright, aborting." });
          return;
        }

        // The maintenance channels are created first so that their ids can
        // be recorded with the lockdown. They are not in the list of
        // channels to hide, because that list was worked out before they
        // existed.
        let maintenanceChannelIds: string[] = [];

        const createChannels = await prompt(
          interaction,
          "**Maintenance channels**\nDo you want me to make the maintenance channels as well?",
        );

        if (createChannels) {
          maintenanceChannelIds = await createMaintenanceChannels(
            guild,
            role,
            reason,
          );
        }

        const result = await maintenanceOn({
          context,
          role,
          maintenanceChannelIds,
        });

        await channel.send(
          `Maintenance mode is on for **${role.name}**. Updated settings for ${plural(result.locked, "channel")}.` +
            (result.failed > 0 ? ` (Failed: ${result.failed})` : "") +
            (maintenanceChannelIds.length > 0
              ? ` Created ${plural(maintenanceChannelIds.length, "maintenance channel")}.`
              : ""),
        );

        await interaction.editReply({
          content: `Maintenance mode is on for **${role.name}**.`,
        });

        return;
      }

      // The record is read before the lockdown is lifted, because lifting
      // it deletes the record of the maintenance channels.
      //
      // The ids are only there when the lockdown has a duration: a
      // lockdown with no duration has no timer row, and the timer row is
      // where the ids live. Without them the channels are found by name,
      // which is what `deleteMaintenanceChannels` falls back to.
      const record = await findLockdown(
        guild.id,
        "maintenance",
        null,
        role.id,
      );
      const job = record ? await findLockdownJob(record.id) : null;
      const maintenanceChannelIds = job?.payload.maintenanceChannelIds ?? [];

      const result = await maintenanceOff({ context, role });

      const deleted = await deleteMaintenanceChannels(
        guild,
        maintenanceChannelIds,
        reason,
      );

      await channel.send(
        `Maintenance mode is off for **${role.name}**. Restored ${plural(result.restored, "channel")}.` +
          (result.failed > 0 ? ` (Failed: ${result.failed})` : "") +
          (result.withoutRecord > 0
            ? ` (${result.withoutRecord} had no record of their previous permissions and were reset to inherit.)`
            : "") +
          (deleted > 0 ? ` Deleted ${plural(deleted, "maintenance channel")}.` : ""),
      );

      await interaction.editReply({
        content: `Maintenance mode is off for **${role.name}**.`,
      });
    });
  },
};

export default maintenanceCommand;
