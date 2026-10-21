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
import {
  assertCanManageCategory,
  deleteCategory,
  nukeCategory,
} from "../category.js";
import { hideCategory, unhideCategory } from "../lockdown.js";
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

        const confirmed = await confirmAction(interaction, {
          title: "Delete category",
          question: `All channels under **${category.name}** will be deleted.`,
          kind: "destructive",
          confirmLabel: "Delete category",
          footer: "The channels and the category are gone for good.",
        });

        if (!confirmed) {
          await replyPanel(
            interaction,
            outcomePanel({
              kind: "neutral",
              title: "Delete cancelled",
              description: "Nothing was deleted.",
              footer: "Run the command again when you are ready.",
            }),
          );
          return;
        }

        const result = await deleteCategory(guild, category, reason);

        await replyPanel(
          interaction,
          outcomePanel({
            kind: "destructive",
            title: "Category deleted",
            description: `Successfully deleted **${category.name}**.`,
            fields: [
              { name: "Deleted", value: String(result.deleted), inline: true },
              ...(result.failed > 0
                ? [{ name: "Failed", value: String(result.failed), inline: true }]
                : []),
            ],
            footer: "There is no undo — the channels are gone.",
          }),
        );

        return;
      }

      if (subcommand === "nuke") {
        if (category.children.cache.size === 0) {
          throw new InputError(`**${category.name}** doesn't have any channels.`);
        }

        const confirmed = await confirmAction(interaction, {
          title: "Nuke category",
          question:
            `All channels under **${category.name}** will be replaced with fresh copies. ` +
            "The category itself stays.",
          kind: "destructive",
          confirmLabel: "Nuke category",
          footer: "The messages of the old channels are gone for good.",
        });

        if (!confirmed) {
          await replyPanel(
            interaction,
            outcomePanel({
              kind: "neutral",
              title: "Nuke cancelled",
              description: "Nothing was replaced.",
              footer: "Run the command again when you are ready.",
            }),
          );
          return;
        }

        const result = await nukeCategory(guild, category, reason);

        const panel = outcomePanel({
          kind: "destructive",
          title: "Category nuked",
          description: `Nuked **${category.name}**.`,
          fields: [
            { name: "Cloned", value: String(result.cloned), inline: true },
            ...(result.failed > 0
              ? [{ name: "Failed", value: String(result.failed), inline: true }]
              : []),
          ],
          footer: "The category itself was left in place.",
        });

        await announcePanel(channel, panel);

        await replyPanel(interaction, panel);

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

        const confirmed = await confirmAction(interaction, {
          title: "Hide category",
          question: `All channels under **${category.name}** will be hidden.`,
          kind: "destructive",
          confirmLabel: "Hide category",
          footer: "The channels stay hidden until `/category unhide`.",
        });

        if (!confirmed) {
          await replyPanel(
            interaction,
            outcomePanel({
              kind: "neutral",
              title: "Hide cancelled",
              description: "Nothing was hidden.",
              footer: "Run the command again when you are ready.",
            }),
          );
          return;
        }

        const result = await hideCategory({
          context,
          categoryId: category.id,
          categoryName: category.name,
        });

        const panel = outcomePanel({
          kind: "destructive",
          title: "Category hidden",
          description: `Hidden **${category.name}**.`,
          fields: [
            { name: "Hidden", value: String(result.locked), inline: true },
            ...(result.failed > 0
              ? [{ name: "Failed", value: String(result.failed), inline: true }]
              : []),
          ],
          footer: "Run `/category unhide` to show the channels again.",
        });

        await announcePanel(channel, panel);

        await replyPanel(interaction, panel);

        return;
      }

      const confirmed = await confirmAction(interaction, {
        title: "Show category",
        question: `All channels under **${category.name}** will be shown again.`,
        kind: "constructive",
        confirmLabel: "Show category",
        footer: "The channels are visible to everybody again.",
      });

      if (!confirmed) {
        await replyPanel(
          interaction,
          outcomePanel({
            kind: "neutral",
            title: "Show cancelled",
            description: "Nothing was shown.",
            footer: "Run the command again when you are ready.",
          }),
        );
        return;
      }

      const result = await unhideCategory({
        context,
        categoryId: category.id,
        categoryName: category.name,
      });

      const panel = outcomePanel({
        kind: "constructive",
        title: "Category shown",
        description: `Unhidden **${category.name}**.`,
        fields: [
          { name: "Shown", value: String(result.restored), inline: true },
          ...(result.failed > 0
            ? [{ name: "Failed", value: String(result.failed), inline: true }]
            : []),
        ],
        footer: "The channels are visible to everybody again.",
      });

      await announcePanel(channel, panel);

      await replyPanel(interaction, panel);
    });
  },
};

export default categoryCommand;
