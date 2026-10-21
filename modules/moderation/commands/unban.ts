/**
 * `/unban` — lift a ban.
 *
 * The id is a string, because a banned member is not in the server and
 * cannot be picked from the member list.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { formatActionReason } from "../reason.js";
import { parseUserId, unbanTarget } from "../members.js";
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

const unbanCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.banMembers,
      missingPermission("ban_members"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Lift a ban.")
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("The id of the banned member.")
        .setMinLength(15)
        .setMaxLength(25)
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

      const id = parseUserId(interaction.options.getString("user_id") ?? "");

      if (!id) {
        throw new InputError(
          "That is not a member id. A member id is a number like 123456789012345678.",
        );
      }

      const reason = formatActionReason(
        author.displayName,
        author.id,
        interaction.options.getString("reason"),
      );

      const result = await unbanTarget(guild, id, reason);

      await replyPanel(
        interaction,
        outcomePanel({
          kind: "constructive",
          title: "Ban lifted",
          description: `${id} has been unbanned.`,
          fields: result.previousReason
            ? [
                {
                  name: "Previous reason",
                  value: result.previousReason,
                  inline: true,
                },
              ]
            : [],
          footer: "The member can join again with an invite.",
        }),
      );
    });
  },
};

export default unbanCommand;
