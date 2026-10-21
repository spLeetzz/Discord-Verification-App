/**
 * `/ban` — ban a member from the server.
 *
 * The target may be a member who is in the server or a bare id: the
 * second case is the hackban Quotient's `MemberID` converter fell back
 * to. The two are separate branches of a union, so a caller cannot treat
 * an id as a member.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { formatActionReason } from "../reason.js";
import {
  assertTargetHierarchy,
  banTarget,
  describeTarget,
  parseUserId,
  resolveMemberTarget,
} from "../members.js";
import type { ModerationCommand } from "../types.js";
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

const banCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.banMembers,
      missingPermission("ban_members"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
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

      const reason = formatActionReason(
        author.displayName,
        author.id,
        interaction.options.getString("reason"),
      );

      await banTarget(guild, target, reason);

      await interaction.editReply({
        content: `${describeTarget(target)} has been banned.`,
      });
    });
  },
};

export default banCommand;
