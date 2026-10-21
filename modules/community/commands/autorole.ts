/**
 * `/autorole` — the roles given to new members.
 *
 * The source's guard was `is_mod`, which is "the caller has
 * `manage_guild`", and it also required the **bot** to have
 * `manage_roles`. Both are kept: the first is the caller's permission and
 * the second is the bot's own.
 *
 * The source's config command crashed when the guild was not in its
 * cache — it called `list(None)` on a role list that needed a guild. The
 * roles are resolved against the guild the command was run in, and a role
 * that no longer exists is shown as deleted instead of crashing the
 * command.
 */

import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Guild, Role } from "discord.js";
import { respond } from "../../../core/context.js";
import { InputError } from "../../../core/errors.js";
import { prompt } from "../../../core/prompt.js";
import * as service from "../service.js";
import { buildAutoroleConfigEmbed } from "../views/embeds.js";
import {
  missingPermission,
  permissionGuard,
  requireGuild,
  requirePermission,
  runCommand,
} from "./shared.js";
import type { CommunityCommand } from "./shared.js";

/**
 * The role the option names.
 *
 * The option can hand back an API shape when the role is not cached, so
 * the role is looked up in the guild.
 */
async function requireRoleOption(
  interaction: ChatInputCommandInteraction,
  name = "role",
): Promise<Role> {
  const option = interaction.options.getRole(name);

  if (!option) {
    throw new InputError("Please pick a role.");
  }

  const guild = requireGuild(interaction);

  const role =
    guild.roles.cache.get(option.id) ??
    (await guild.roles.fetch(option.id).catch(() => null));

  if (!role) {
    throw new InputError("That role is not in this server.");
  }

  return role;
}

/**
 * Does the bot have the permission it needs to give the role?
 */
function botCanManageRoles(interaction: ChatInputCommandInteraction): boolean {
  const guild = requireGuild(interaction);

  const me = guild.members.me;

  if (!me) return false;

  return me.permissions.has(PermissionFlagsBits.ManageRoles);
}

/**
 * One line per role id.
 *
 * A role that no longer exists is shown as deleted rather than crashing
 * the command — the source's `getattr(role, "mention", "Deleted")` did
 * the same, but it crashed first when the *guild* was missing.
 */
function describeRoles(guild: Guild, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const role = guild.roles.cache.get(id);

    return role ? role.toString() : `${id} (deleted role)`;
  });
}

const autoroleCommand: CommunityCommand = {
  data: new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Manage the roles given to new members.")
    .addSubcommand((sub) =>
      sub
        .setName("humans")
        .setDescription("Add or remove a role for human members.")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("The role to add or remove.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("bots")
        .setDescription("Add or remove a role for bot members.")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("The role to add or remove.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("config").setDescription("Show the auto-role configuration."),
    )
    .addSubcommand((sub) =>
      sub.setName("off").setDescription("Turn the auto-roles off."),
    ),

  guards: [
    permissionGuard(
      PermissionFlagsBits.ManageGuild,
      missingPermission("manage_guild"),
    ),
  ],

  async execute(interaction) {
    await runCommand(interaction, async () => {
      await requirePermission(
        interaction,
        PermissionFlagsBits.ManageGuild,
        "manage_guild",
      );

      switch (interaction.options.getSubcommand()) {
        case "humans":
          await toggleRole(interaction, "humans");
          return;
        case "bots":
          await toggleRole(interaction, "bots");
          return;
        case "config":
          await showConfig(interaction);
          return;
        case "off":
          await turnOff(interaction);
          return;
        default:
          throw new InputError("I do not know that auto-role command.");
      }
    });
  },
};

/**
 * Adds a role to an auto-role list, or removes it when it is there.
 */
async function toggleRole(
  interaction: ChatInputCommandInteraction,
  kind: "humans" | "bots",
): Promise<void> {
  const guild = requireGuild(interaction);

  if (!botCanManageRoles(interaction)) {
    throw new InputError("I need the `manage_roles` permission for that.");
  }

  const role = await requireRoleOption(interaction);

  const result = await service.toggleAutoroleRole({
    guildId: guild.id,
    kind,
    roleId: role.id,
  });

  const list = kind === "humans" ? "human" : "bot";

  await respond(interaction, {
    content: result.added
      ? `Added ${role.toString()} to the ${list} auto-roles.`
      : `Removed ${role.toString()} from the ${list} auto-roles.`,
  });
}

/**
 * Shows the auto-role configuration.
 */
async function showConfig(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  const config = await service.getAutoroleConfig(guild.id);

  if (!config) {
    throw new InputError(
      "This server has no auto-roles yet. Add one with `/autorole humans` or `/autorole bots`.",
    );
  }

  await respond(interaction, {
    embeds: [
      buildAutoroleConfigEmbed(
        describeRoles(guild, config.humans),
        describeRoles(guild, config.bots),
      ),
    ],
  });
}

/**
 * Turns the auto-roles off, after a confirmation.
 */
async function turnOff(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  const config = await service.getAutoroleConfig(guild.id);

  if (!config) {
    throw new InputError("This server has no auto-roles yet.");
  }

  if (config.humans.length === 0 && config.bots.length === 0) {
    throw new InputError("The auto-roles are already off.");
  }

  const confirmed = await prompt(
    interaction,
    "Are you sure you want to turn the auto-roles off?",
  );

  if (!confirmed) {
    await respond(interaction, { content: "Alright, I left them alone." });
    return;
  }

  await service.clearAutoroleRoles(guild.id);

  await respond(interaction, { content: "Auto-roles turned off." });
}

export default autoroleCommand;
