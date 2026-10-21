/**
 * `/category` — delete, hide, unhide and nuke a category.
 *
 * Two Quotient bugs are fixed here:
 *
 *  1. `category nuke` said it deleted and recreated the category, but it
 *     only ever replaced the category's *channels*. This port does what
 *     the name says and says so in the reply: the channels are replaced,
 *     the category stays.
 *  2. `category hide` and `category unhide` wrote the whole computed
 *     `@everyone` permission set back, which dropped every other
 *     `@everyone`-level tweak on the channel. Only the one permission that
 *     changes is written now.
 */

import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { CategoryChannel } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { plural } from "../../../core/text.js";
import {
  assertCanManageCategory,
  deleteCategory,
  nukeCategory,
} from "../category.js";
import { hideCategory, unhideCategory } from "../lockdown.js";
import type { LockContext } from "../lockdown.js";
import type { ModerationCommand } from "../types.js";
import { prompt } from "../../../core/prompt.js";
import {
  MODERATION_PERMISSIONS,
  missingPermission,
  permissionGuard,
  requireGuild,
  requireMember,
  requireTextChannel,
  runCommand,
} from "./shared.js";

/** The category the command is aimed at. */
function requireCategory(
  interaction: ChatInputCommandInteraction,
): CategoryChannel {
  const channel = interaction.options.getChannel("category", true, [
    ChannelType.GuildCategory,
  ]);

  if (!channel || channel.type !== ChannelType.GuildCategory) {
    throw new InputError("Please pick a category.");
  }

  return channel;
}

const categoryCommand: ModerationCommand = {
  staffOnly: true,
  ephemeral: false,
  guards: [
    permissionGuard(
      MODERATION_PERMISSIONS.manageChannels,
      missingPermission("manage_channels"),
    ),
  ],
  data: new SlashCommandBuilder()
    .setName("category")
    .setDescription("Delete, hide, unhide or nuke a category.")
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a category and everything under it.")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("The category.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("hide")
        .setDescription("Hide a category and everything under it.")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("The category.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unhide")
        .setDescription("Show a hidden category again.")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("The category.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("nuke")
        .setDescription("Replace every channel of a category with a fresh copy.")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("The category.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);
      const author = await requireMember(interaction);
      const channel = requireTextChannel(interaction);
      const subcommand = interaction.options.getSubcommand();
      const category = requireCategory(interaction);

      assertCanManageCategory(guild, category);

      const reason = `Action done by ${author.displayName} (ID: ${author.id})`;

      if (subcommand === "delete") {
        if (category.children.cache.size === 0) {
          throw new InputError(`**${category.name}** doesn't have any channels.`);
        }

        const confirmed = await prompt(
          interaction,
          `All channels under **${category.name}** will be deleted. Are you sure?`,
        );

        if (!confirmed) {
          await interaction.editReply({ content: "Ok, aborting." });
          return;
        }

        const result = await deleteCategory(guild, category, reason);

        await interaction.editReply({
          content: `Successfully deleted **${category.name}**. (Deleted: ${result.deleted}, Failed: ${result.failed})`,
        });

        return;
      }

      if (subcommand === "nuke") {
        if (category.children.cache.size === 0) {
          throw new InputError(`**${category.name}** doesn't have any channels.`);
        }

        const confirmed = await prompt(
          interaction,
          `All channels under **${category.name}** will be replaced with fresh copies. The category itself stays. Are you sure?`,
        );

        if (!confirmed) {
          await interaction.editReply({ content: "Ok, aborting." });
          return;
        }

        const result = await nukeCategory(guild, category, reason);

        await channel.send(
          `Nuked **${category.name}**: ${plural(result.cloned, "channel")} replaced with fresh copies` +
            (result.failed > 0 ? ` (Failed: ${result.failed})` : "") +
            ". The category itself was left in place.",
        );

        await interaction.editReply({
          content: `Nuked **${category.name}**. (Cloned: ${result.cloned}, Failed: ${result.failed}) The category itself was left in place.`,
        });

        return;
      }

      const context: LockContext = {
        guild,
        author,
        reason,
        sourceChannelId: channel.id,
      };

      if (subcommand === "hide") {
        if (category.children.cache.size === 0) {
          throw new InputError(`**${category.name}** doesn't have any channels.`);
        }

        const confirmed = await prompt(
          interaction,
          `All channels under **${category.name}** will be hidden. Are you sure?`,
        );

        if (!confirmed) {
          await interaction.editReply({ content: "Ok, aborting." });
          return;
        }

        const result = await hideCategory({
          context,
          categoryId: category.id,
          categoryName: category.name,
        });

        await channel.send(
          `Hidden **${category.name}**. (Hidden: ${result.locked}, Failed: ${result.failed})`,
        );

        await interaction.editReply({
          content: `Hidden **${category.name}**.`,
        });

        return;
      }

      const confirmed = await prompt(
        interaction,
        `All channels under **${category.name}** will be shown again. Are you sure?`,
      );

      if (!confirmed) {
        await interaction.editReply({ content: "Ok, aborting." });
        return;
      }

      const result = await unhideCategory({
        context,
        categoryId: category.id,
        categoryName: category.name,
      });

      await channel.send(
        `Unhidden **${category.name}**. (Unhidden: ${result.restored}, Failed: ${result.failed})`,
      );

      await interaction.editReply({
        content: `Unhidden **${category.name}**.`,
      });
    });
  },
};

export default categoryCommand;
