/**
 * The `/role` and `/rrole` commands.
 *
 * Quotient had two groups, `role` and `rrole`, each with a greedy member
 * list and three bulk subcommands. discord.js has no greedy arguments, so
 * the member list becomes a string of mentions that is parsed, and the
 * "everybody" path becomes an explicit `apply_to_all` flag — the flag
 * exists because the "everybody" path is a *confirm* in the source, and a
 * confirm needs a deliberate choice.
 *
 * The hierarchy guard is `core/guards.ts`'s `canManageRole` — the five
 * rules, in order, are not reimplemented here.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { plural } from "../../../core/text.js";
import { formatActionReason } from "../reason.js";
import {
  applyRoleToMembers,
  assertCanManageRole,
  parseMentionIds,
  selectMembersForRole,
} from "../roles.js";
import type { RoleAction, RoleScope } from "../roles.js";
import type { ModerationCommand } from "../types.js";
import { confirmAction } from "../views/confirm.js";
import {
  announcePanel,
  emptyState,
  outcomePanel,
  replyPanel,
} from "../views/panels.js";
import {
  issueRoleRevert,
  roleRevertButton,
  roleRevertPanel,
} from "../views/role-revert.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireGuild,
  requireMember,
  requireRole,
  requireTextChannel,
  runCommand,
} from "./shared.js";

/** How a role command is configured. */
export interface RoleCommandConfig {
  /** The command's name. */
  readonly name: string;
  readonly description: string;
  /** What the command does. */
  readonly action: RoleAction;
  /** The name of the subcommand that takes a member list. */
  readonly memberSubcommand: string;
  /** The verb used in the messages. */
  readonly verb: string;
  /** The verb used when the action is undone. */
  readonly inverseVerb: string;
}

/**
 * Builds a role command.
 *
 * The two commands are the same code with different words, so they are
 * built from one function rather than copied.
 */
export function buildRoleCommand(config: RoleCommandConfig): ModerationCommand {
  const { action } = config;

  return {
    staffOnly: true,
    ephemeral: false,
    guards: [
      permissionGuard(
        MODERATION_PERMISSIONS.manageRoles,
        missingPermission("manage_roles"),
      ),
    ],
    data: new SlashCommandBuilder()
      .setName(config.name)
      .setDescription(config.description)
      .addSubcommand((sub) =>
        sub
          .setName(config.memberSubcommand)
          .setDescription(
            `${config.verb === "add" ? "Give" : "Take"} the role to or from specific members.`,
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("The role to change.")
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("members")
              .setDescription("The members, as mentions.")
              .setMaxLength(1000),
          )
          .addBooleanOption((option) =>
            option
              .setName("apply_to_all")
              .setDescription("Apply it to every member of the server instead."),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("humans")
          .setDescription(
            `${config.verb === "add" ? "Give" : "Take"} the role to or from every human member.`,
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("The role to change.")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("bots")
          .setDescription(
            `${config.verb === "add" ? "Give" : "Take"} the role to or from every bot member.`,
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("The role to change.")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("all")
          .setDescription(
            `${config.verb === "add" ? "Give" : "Take"} the role to or from every member.`,
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("The role to change.")
              .setRequired(true),
          ),
      ),

    async execute(interaction) {
      await runCommand(interaction, async () => {
        const guild = requireGuild(interaction);
        const author = await requireMember(interaction);
        const channel = requireTextChannel(interaction);
        const role = await requireRole(interaction);

        // The five hierarchy rules, from `core/guards.ts`.
        await assertCanManageRole(interaction, role);

        const subcommand = interaction.options.getSubcommand();
        const reason = formatActionReason(author.displayName, author.id);

        let memberIds: string[];
        let bulk = false;

        if (subcommand === config.memberSubcommand) {
          const applyToAll =
            interaction.options.getBoolean("apply_to_all") ?? false;

          if (applyToAll) {
            memberIds = selectMembersForRole(guild, role, "all", action).map(
              (member) => member.id,
            );
            bulk = true;
          } else {
            memberIds = parseMentionIds(
              interaction.options.getString("members") ?? "",
            );

            if (memberIds.length === 0) {
              throw new InputError(
                "Tell me which members to change, or use the `apply_to_all` option.",
              );
            }
          }
        } else {
          const scope = subcommand as RoleScope;

          memberIds = selectMembersForRole(guild, role, scope, action).map(
            (member) => member.id,
          );
          bulk = true;
        }

        if (bulk) {
          const adding = config.verb === "add";

          const confirmed = await confirmAction(interaction, {
            title: adding ? "Give role" : "Take role",
            question: `${role.toString()} will be ${
              adding ? "given to" : "taken from"
            } ${plural(memberIds.length, "member")} in this server.`,
            kind: adding ? "constructive" : "destructive",
            confirmLabel: adding ? "Give role" : "Take role",
            footer: adding
              ? "The button in the channel below undoes it."
              : "The button in the channel below gives the role back.",
          });

          if (!confirmed) {
            await replyPanel(
              interaction,
              outcomePanel({
                kind: "neutral",
                title: adding ? "Give role cancelled" : "Take role cancelled",
                description: "Nobody was changed.",
                footer: "Run the command again when you are ready.",
              }),
            );
            return;
          }
        }

        if (memberIds.length === 0) {
          await replyPanel(
            interaction,
            emptyState({
              title: "Nobody to change",
              description: "No member matched, so nobody was changed.",
              footer:
                "Pick the members to change, or use the `apply_to_all` option.",
            }),
          );
          return;
        }

        const result = await applyRoleToMembers({
          guild,
          role,
          memberIds,
          action,
          reason,
        });

        const token = issueRoleRevert({
          guildId: guild.id,
          roleId: role.id,
          memberIds: result.memberIds,
          action,
          authorId: author.id,
          authorLabel: author.displayName,
        });

        const panel = roleRevertPanel(action, role, result);

        // The success message carries the revert button, and it is
        // **public**: a second moderator may need to undo it, and an
        // ephemeral message with a button in it is a button nobody sees.
        await announcePanel(channel, {
          embeds: panel.embeds,
          components: [roleRevertButton(action, token)],
        });

        await replyPanel(interaction, panel);
      });
    },
  };
}
