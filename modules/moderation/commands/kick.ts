/**
 * `/kick` — remove a member from the server.
 *
 * The target is a string rather than a user option, because a member who
 * has already left cannot be picked from a list.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { formatActionReason } from "../reason.js";
import {
  assertTargetHierarchy,
  describeTarget,
  kickTarget,
  parseUserId,
  resolveMemberTarget,
} from "../members.js";
import type { ModerationCommand } from "../types.js";
import { outcomePanel, replyPanel } from "../views/panels.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireGuild,
  requireMember,
  runCommand,
} from "./shared.js";

/** The longest reason the option accepts. The real cap is in `reason.ts`. */
const MAX_REASON_OPTION_LENGTH = 400;

const kickCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.kickMembers,
      missingPermission("kick_members"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server.")
    .addStringOption((option) =>
      option
        .setName("target")
        .setDescription("The member, as a mention or an id.")
        .setMaxLength(100)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why. It goes into the audit log.")
        .setMaxLength(MAX_REASON_OPTION_LENGTH),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);
      const author = await requireMember(interaction);

      const id = parseUserId(interaction.options.getString("target") ?? "");

      if (!id) {
        throw new InputError(
          "That is not a member mention or a member id. A member id is a number like 123456789012345678.",
        );
      }

      const target = await resolveMemberTarget(guild, id);

      assertTargetHierarchy(guild, author, target);

      const given = interaction.options.getString("reason");

      const reason = formatActionReason(author.displayName, author.id, given);

      await kickTarget(guild, target, reason);

      await replyPanel(
        interaction,
        outcomePanel({
          kind: "destructive",
          title: "Member kicked",
          description: `${describeTarget(target)} has been kicked.`,
          fields: given
            ? [{ name: "Reason", value: given, inline: true }]
            : [],
          footer: "They can join again with an invite.",
        }),
      );
    });
  },
};

export default kickCommand;
