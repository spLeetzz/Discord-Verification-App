/**
 * `/lock` — lock a channel, or the whole server.
 *
 * The expiry is a row in the durable `jobs` table, never a `setTimeout`:
 * a timer dies with the process and the channel stays locked forever.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { parseNaturalTime } from "../../../core/time.js";
import { formatActionReason } from "../reason.js";
import {
  channelsToLockForServer,
  lockChannel,
  lockServer,
} from "../lockdown.js";
import type { LockContext } from "../lockdown.js";
import type { ModerationCommand } from "../types.js";
import { confirmAction } from "../views/confirm.js";
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

/**
 * Reads the expiry out of the option.
 *
 * @returns the instant the lockdown lifts, or `null` when there is no
 *          expiry.
 */
export function parseExpiry(input: string | null): Date | null {
  if (!input || input.trim() === "") return null;

  const parsed = parseNaturalTime(input);

  if (!parsed) {
    throw new InputError(
      "I could not work out when that is. Try something like `2 hours`, `1 day` or `tomorrow at 7pm`.",
    );
  }

  if (parsed.getTime() <= Date.now()) {
    throw new InputError("That is in the past.");
  }

  return parsed;
}

const lockCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageChannels,
      missingPermission("manage_channels"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock a channel, or the whole server.")
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Lock one channel.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to lock. Defaults to this one."),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("How long the lock lasts, e.g. `2 hours`.")
            .setMaxLength(50),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("server")
        .setDescription("Lock every channel @everyone can write in.")
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("How long the lock lasts, e.g. `2 hours`.")
            .setMaxLength(50),
        ),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);
      const author = await requireMember(interaction);
      const channel = requireTextChannel(interaction);
      const subcommand = interaction.options.getSubcommand();
      const duration = parseExpiry(interaction.options.getString("duration"));

      const context: LockContext = {
        guild,
        author,
        reason: formatActionReason(author.displayName, author.id),
        sourceChannelId: channel.id,
      };

      if (subcommand === "server") {
        const channels = channelsToLockForServer(guild);

        if (channels.length === 0) {
          throw new InputError(
            "@everyone has `send_messages` enabled in no channel I can edit.",
          );
        }

        const confirmed = await confirmAction(interaction, {
          title: "Lock server",
          question: `\`${channels.length}\` channel${
            channels.length === 1 ? "" : "s"
          } have send messages enabled for @everyone, and I can edit ${
            channels.length
          } of them.`,
          kind: "destructive",
          confirmLabel: "Lock server",
          footer: "The channels stay locked until `/unlock server` or the expiry.",
        });

        if (!confirmed) {
          await replyPanel(
            interaction,
            outcomePanel({
              kind: "neutral",
              title: "Lock server cancelled",
              description: "Nothing was locked.",
              footer: "Run the command again when you are ready.",
            }),
          );
          return;
        }

        const result = await lockServer({ context, duration });

        const panel = outcomePanel({
          kind: "destructive",
          title: "Server locked",
          description: `Locked down ${result.locked} channel${
            result.locked === 1 ? "" : "s"
          }.`,
          fields: [
            { name: "Channels", value: String(result.locked), inline: true },
            ...(result.failed > 0
              ? [{ name: "Failed", value: String(result.failed), inline: true }]
              : []),
            ...(duration
              ? [
                  {
                    name: "Until",
                    value: `<t:${Math.floor(duration.getTime() / 1000)}:F>`,
                    inline: true,
                  },
                ]
              : []),
          ],
          footer: "Run `/unlock server` to lift the lockdown.",
        });

        await announcePanel(channel, panel);

        await replyPanel(interaction, panel);

        return;
      }

      const target = await resolveLockableChannel(interaction, "channel");
      const result = await lockChannel({ context, channel: target, duration });

      const panel = outcomePanel({
        kind: "destructive",
        title: "Channel locked",
        description: `Locked down **${target.name}**.`,
        fields: [
          ...(duration
            ? [
                {
                  name: "Until",
                  value: `<t:${Math.floor(duration.getTime() / 1000)}:F>`,
                  inline: true,
                },
              ]
            : []),
          ...(result.failed > 0
            ? [{ name: "Failed", value: String(result.failed), inline: true }]
            : []),
        ],
        footer: "Run `/unlock` to lift the lockdown.",
      });

      await announcePanel(channel, panel);

      await replyPanel(interaction, panel);
    });
  },
};

export default lockCommand;
