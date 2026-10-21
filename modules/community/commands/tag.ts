/**
 * `/tag` — the server's canned messages.
 *
 * Fourteen subcommands, which is the shape Quotient's `tag` group had.
 * The interesting decisions are in `service.ts` and `rules.ts`; this file
 * reads the options and renders the answers.
 *
 * Two of the source's bugs are fixed here:
 *
 *  - the tag command sent the embed **and** the raw content, because the
 *    embed branch did not return. It returns now;
 *  - the tag name was validated in lower case and looked up in the
 *    original case, so `/tag Rules` and `/tag rules` were two different
 *    tags. The lookup is case-insensitive now, and the database's
 *    `UNIQUE (guild_id, name)` constraint enforces it.
 */

import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { respond, sendFile } from "../../../core/context.js";
import { denialMessage, InputError } from "../../../core/errors.js";
import { embedTemplateToBuilder, embedTemplateToJSON, parseEmbedTemplate } from "../../../core/embed-builder.js";
import { escapeMarkdown, escapeMentions } from "../../../core/escape.js";
import { Paginator } from "../../../core/paginator.js";
import { plural, truncate } from "../../../core/text.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { TAG_CONTENT_MAX_LENGTH, TAG_NAME_MAX_LENGTH } from "../rules.js";
import { buildGuildTagStatsEmbed, buildMemberTagStatsEmbed, buildTagInfoEmbed } from "../views/embeds.js";
import {
  canManageGuild,
  displayName,
  requireGuild,
  runCommand,
} from "./shared.js";
import type { CommunityCommand } from "./shared.js";

/** The longest a raw tag body may be before it is sent as a file. */
const RAW_FILE_THRESHOLD = 1990;

/**
 * Reads a required string option.
 *
 * @throws {InputError} when the option is missing.
 */
function requiredString(
  interaction: ChatInputCommandInteraction,
  name: string,
): string {
  const value = interaction.options.getString(name);

  if (value === null) {
    throw new InputError(`Please give the \`${name}\` option a value.`);
  }

  return value;
}

/**
 * A paginator namespace.
 *
 * The namespace travels in the custom id, so it may not hold a colon and
 * it has to be short enough for Discord's hundred character limit.
 */
function namespace(...parts: string[]): string {
  return parts
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 90);
}

/**
 * Finds a tag, or refuses with the source's "maybe you were looking for"
 * hint.
 */
async function requireTag(
  guildId: string,
  name: string,
): Promise<import("../types.js").TagRecord> {
  const tag = await service.findTag(guildId, name);

  if (tag) return tag;

  const suggestions = await repo.listTagsMatching(guildId, name, 3);

  let message = `**${name}** is not a valid tag name.`;

  if (suggestions.length > 0) {
    const names = suggestions.map((candidate) => `- ${candidate.name}`).join("\n");

    message += `\n\nMaybe you were looking for:\n${names}`;
  }

  throw new InputError(message);
}

/**
 * Is the channel the command was run in NSFW?
 */
function channelIsNsfw(interaction: ChatInputCommandInteraction): boolean {
  const channel = interaction.channel;

  if (!channel || !("nsfw" in channel)) return false;

  const value = (channel as { nsfw?: unknown }).nsfw;

  return typeof value === "boolean" ? value : false;
}

/**
 * Refuses an NSFW tag outside an NSFW channel.
 */
function refuseNsfwTag(
  interaction: ChatInputCommandInteraction,
  isNsfw: boolean,
): void {
  if (isNsfw && !channelIsNsfw(interaction)) {
    throw new InputError("This tag can only be used in NSFW channels.");
  }
}

/**
 * The body of a tag, ready to be stored.
 *
 * An embed tag's body is a **JSON template** (D32), never a Python
 * literal string: the source re-parsed the column with
 * `ast.literal_eval` on every use, so any other code path that wrote the
 * column crashed the next render.
 */
function buildTagBody(
  content: string,
  isEmbed: boolean,
): { body: string; isEmbed: boolean } {
  if (!isEmbed) {
    if (content.length > TAG_CONTENT_MAX_LENGTH) {
      throw new InputError(
        `A tag may hold at most ${TAG_CONTENT_MAX_LENGTH} characters.`,
      );
    }

    return { body: content, isEmbed: false };
  }

  const template = parseEmbedTemplate(content);

  if (!template) {
    throw new InputError(
      "That is not a valid embed template. It has to be a JSON object, for example `{\"title\": \"Rules\", \"description\": \"Be nice.\"}`.",
    );
  }

  return { body: embedTemplateToJSON(template), isEmbed: true };
}

const tagCommand: CommunityCommand = {
  data: new SlashCommandBuilder()
    .setName("tag")
    .setDescription("Use and manage this server's tags.")
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Post a tag.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("raw")
        .setDescription("Show a tag's raw content, escaped so it is safe to read.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List the server's tags, or one member's.")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Only list this member's tags."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("Show a tag's statistics.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("claim")
        .setDescription("Take over a tag whose owner has left the server.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a tag.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName("content")
            .setDescription("The body of the tag.")
            .setMaxLength(TAG_CONTENT_MAX_LENGTH),
        )
        .addBooleanOption((option) =>
          option
            .setName("embed")
            .setDescription("The body is a JSON embed template, not plain text."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a tag you own.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("transfer")
        .setDescription("Give a tag you own to somebody else.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        )
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Who the tag goes to.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("nsfw")
        .setDescription("Turn a tag's NSFW flag on or off.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("mine").setDescription("List the tags you own."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("purge")
        .setDescription("Delete every tag a member owns.")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Whose tags are deleted.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Change a tag you own.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The name of the tag.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName("content")
            .setDescription("The new body of the tag.")
            .setMaxLength(TAG_CONTENT_MAX_LENGTH),
        )
        .addBooleanOption((option) =>
          option
            .setName("embed")
            .setDescription("The body is a JSON embed template, not plain text."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Find tags by name.")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("What to look for.")
            .setMaxLength(TAG_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("stats")
        .setDescription("Show the tag statistics of the server, or of a member.")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Only show this member's statistics."),
        ),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      switch (interaction.options.getSubcommand()) {
        case "show":
          await showTag(interaction);
          return;
        case "raw":
          await rawTag(interaction);
          return;
        case "list":
          await listTags(interaction);
          return;
        case "info":
          await infoTag(interaction);
          return;
        case "claim":
          await claimTag(interaction);
          return;
        case "create":
          await createTag(interaction);
          return;
        case "delete":
          await deleteTag(interaction);
          return;
        case "transfer":
          await transferTag(interaction);
          return;
        case "nsfw":
          await nsfwTag(interaction);
          return;
        case "mine":
          await mineTags(interaction);
          return;
        case "purge":
          await purgeTags(interaction);
          return;
        case "edit":
          await editTag(interaction);
          return;
        case "search":
          await searchTags(interaction);
          return;
        case "stats":
          await statsTags(interaction);
          return;
        default:
          throw new InputError("I do not know that tag command.");
      }
    });
  },
};

/* ------------------------------------------------------------------ *
 * The subcommands
 * ------------------------------------------------------------------ */

/**
 * Posts a tag.
 */
async function showTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const tag = await requireTag(guild.id, name);

  refuseNsfwTag(interaction, tag.isNsfw);

  if (tag.isEmbed) {
    const template = parseEmbedTemplate(tag.content);

    if (!template) {
      throw new InputError(
        "This tag's embed template is broken, so it cannot be shown. Its owner has to edit it.",
      );
    }

    await respond(interaction, { embeds: [embedTemplateToBuilder(template)] });

    // The source fell through here and sent the raw content as well, so
    // every embed tag was posted twice (D44).
    await service.countTagUse(guild.id, tag.name);
    return;
  }

  if (!tag.content) {
    throw new InputError("That tag does not have any content.");
  }

  await respond(interaction, { content: tag.content });

  await service.countTagUse(guild.id, tag.name);
}

/**
 * Shows a tag's raw content, escaped so it is safe to read out loud.
 */
async function rawTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const tag = await requireTag(guild.id, name);

  refuseNsfwTag(interaction, tag.isNsfw);

  if (!tag.content) {
    throw new InputError("That tag does not have any content.");
  }

  // The markdown is escaped first and the mentions second, exactly as the
  // source did it. The escaped text cannot ping anybody, so it does not
  // need `allowed_mentions` on top.
  const escaped = escapeMentions(escapeMarkdown(tag.content));

  if (escaped.length > RAW_FILE_THRESHOLD) {
    await sendFile(interaction, escaped, {
      name: "message_too_long.txt",
      escapeMentions: false,
    });

    return;
  }

  await respond(interaction, { content: escaped });
}

/**
 * Lists the server's tags, or one member's.
 */
async function listTags(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const member = interaction.options.getUser("member");

  const ownerId = member?.id ?? null;

  const pager = new Paginator({
    namespace: namespace(
      "tags",
      ownerId ? "of" : "all",
      guild.id,
      ownerId ?? "",
    ),
    perPage: 12,
    title: ownerId ? "Tags owned by a member" : "Total Tags",
    loadPages: async () => {
      const rows = ownerId
        ? await repo.listTagsByOwner(guild.id, ownerId)
        : await repo.listTags(guild.id);

      if (rows.length === 0) return [];

      return chunk(
        rows.map((tag, index) =>
          `\`${String(index + 1).padStart(2, "0")}\` ${escapeMarkdown(tag.name)} (ID: ${tag.id})`,
        ),
        12,
      );
    },
  });

  await pager.start(interaction);
}

/**
 * Shows a tag's statistics.
 */
async function infoTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const tag = await requireTag(guild.id, name);

  const owner = displayName(guild, tag.ownerId);

  await respond(interaction, { embeds: [buildTagInfoEmbed(tag, owner)] });
}

/**
 * Takes over a tag whose owner has left the server.
 */
async function claimTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const tag = await requireTag(guild.id, name);

  const ownerIsStillHere = guild.members.cache.has(tag.ownerId);

  await service.claimTag({
    guildId: guild.id,
    name: tag.name,
    callerId: interaction.user.id,
    ownerIsStillInGuild: ownerIsStillHere,
  });

  await respond(interaction, {
    content: "Transferred the tag to you.",
  });
}

/**
 * Creates a tag.
 */
async function createTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");
  const content = requiredString(interaction, "content");
  const isEmbed = interaction.options.getBoolean("embed") ?? false;

  const body = buildTagBody(content, isEmbed);

  const tag = await service.createTag({
    guildId: guild.id,
    name,
    content: body.body,
    isEmbed: body.isEmbed,
    ownerId: interaction.user.id,
  });

  await respond(interaction, {
    content: `Created the tag **${tag.name}** (ID: \`${tag.id}\`).`,
  });
}

/**
 * Deletes a tag.
 */
async function deleteTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const canManage = await canManageGuild(interaction);

  const tag = await service.deleteTag({
    guildId: guild.id,
    name,
    callerId: interaction.user.id,
    canManage,
  });

  await respond(interaction, { content: `Deleted **${tag.name}**.` });
}

/**
 * Gives a tag to somebody else.
 */
async function transferTag(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");
  const member = interaction.options.getUser("member");

  if (!member) {
    throw new InputError("Please pick a member to give the tag to.");
  }

  await service.transferTag({
    guildId: guild.id,
    name,
    callerId: interaction.user.id,
    toUserId: member.id,
  });

  await respond(interaction, {
    content: `Transferred **${name}** to <@${member.id}>.`,
  });
}

/**
 * Turns a tag's NSFW flag on or off.
 */
async function nsfwTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");

  const canManage = await canManageGuild(interaction);

  const result = await service.toggleTagNsfw({
    guildId: guild.id,
    name,
    callerId: interaction.user.id,
    canManage,
  });

  await respond(interaction, {
    content: `Tag NSFW toggled **${result.nsfw ? "ON" : "OFF"}**.`,
  });
}

/**
 * Lists the tags the caller owns.
 */
async function mineTags(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const ownerId = interaction.user.id;

  const pager = new Paginator({
    namespace: namespace("tags", "mine", guild.id, ownerId),
    perPage: 12,
    title: "Tags you own",
    loadPages: async () => {
      const rows = await repo.listTagsByOwner(guild.id, ownerId);

      if (rows.length === 0) return [];

      return chunk(
        rows.map((tag, index) =>
          `\`${String(index + 1).padStart(2, "0")}\` ${escapeMarkdown(tag.name)} (ID: ${tag.id})`,
        ),
        12,
      );
    },
  });

  await pager.start(interaction);
}

/**
 * Deletes every tag a member owns.
 */
async function purgeTags(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const member = interaction.options.getUser("member");

  if (!member) {
    throw new InputError("Please pick a member.");
  }

  if (!(await canManageGuild(interaction))) {
    throw new InputError(
      "You need the `manage_guild` permission to delete somebody else's tags.",
    );
  }

  const count = await service.purgeTagsOfOwner(guild.id, member.id);

  if (count === 0) {
    throw new InputError("That member does not own any tags.");
  }

  await respond(interaction, {
    content: `Deleted ${plural(count, "tag")} of **${member.username}**.`,
  });
}

/**
 * Changes a tag.
 */
async function editTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  const name = requiredString(interaction, "name");
  const content = requiredString(interaction, "content");
  const isEmbed = interaction.options.getBoolean("embed") ?? false;

  const body = buildTagBody(content, isEmbed);

  const canManage = await canManageGuild(interaction);

  await service.editTag({
    guildId: guild.id,
    name,
    content: body.body,
    isEmbed: body.isEmbed,
    callerId: interaction.user.id,
    canManage,
  });

  await respond(interaction, { content: "Tag updated." });
}

/**
 * Finds tags by name.
 */
async function searchTags(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);
  const query = requiredString(interaction, "query");

  const rows = await repo.listTagsMatching(guild.id, query, 25);

  if (rows.length === 0) {
    throw new InputError("No tags found.");
  }

  const pager = new Paginator({
    namespace: namespace("tags", "find", guild.id, query),
    perPage: 10,
    title: `Matching Tags: ${rows.length}`,
    loadPages: async () => {
      const found = await repo.listTagsMatching(guild.id, query, 25);

      if (found.length === 0) return [];

      return chunk(
        found.map((tag, index) =>
          `\`${String(index + 1).padStart(2, "0")}\` ${escapeMarkdown(tag.name)} (ID: ${tag.id})`,
        ),
        10,
      );
    },
  });

  await pager.start(interaction);
}

/**
 * Shows the tag statistics of the server, or of a member.
 */
async function statsTags(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);
  const member = interaction.options.getUser("member");

  if (!member) {
    const stats = await repo.getGuildTagStats(guild.id);

    await respond(interaction, {
      embeds: [buildGuildTagStatsEmbed(stats)],
    });

    return;
  }

  const [tags, commandUses] = await Promise.all([
    repo.listMemberTagStats(guild.id, member.id, 3),
    repo.countTagCommandUses(guild.id, member.id),
  ]);

  const owned = tags[0];

  await respond(interaction, {
    embeds: [
      buildMemberTagStatsEmbed(displayName(guild, member.id), {
        ownedTags: owned?.totalTags ?? 0,
        ownedUses: owned?.totalUses ?? 0,
        commandUses,
        tags,
      }),
    ],
  });
}

/**
 * Splits a list of lines into pages.
 */
function chunk(lines: string[], perPage: number): string[][] {
  const pages: string[][] = [];

  for (let index = 0; index < lines.length; index += perPage) {
    pages.push(lines.slice(index, index + perPage));
  }

  return pages;
}

export default tagCommand;

/** The message a name that is too long gets. */
export const TOO_LONG_MESSAGE = truncate(
  `A tag name may be at most ${TAG_NAME_MAX_LENGTH} characters.`,
  100,
);

/** Re-exported so the command layer does not have to import the errors. */
export { denialMessage };
