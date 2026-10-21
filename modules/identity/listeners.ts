/**
 * The message listeners this area owns.
 *
 * Three of them, one per feature:
 *
 *  - the **tag check** listener, which checks a captain's mentions and
 *    reacts to the message;
 *  - the **easy tag** listener, which turns raw ids and `@names` into real
 *    mentions;
 *  - the **screenshot verification** listener, which checks the pictures a
 *    participant posts.
 *
 * None of them talks to Discord when the channel is not one of ours: the
 * channel cache answers that question without a database round trip.
 */

import { PermissionFlagsBits } from "discord.js";
import type { Attachment, GuildMember, Message } from "discord.js";
import { STAFF_ROLE_NAME } from "../../core/constants.js";
import { EMBED_COLOR } from "../../core/constants.js";
import { EmbedBuilder } from "discord.js";
import { findTeam } from "../../core/team-name.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import * as cache from "./cache.js";
import * as groups from "./groups.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { buildEasyTagReply, extractEasyTags, resolveEasyTag } from "./easytag.js";
import { NO_TAG_MESSAGE } from "./easytag.js";
import type { EasyTagMember } from "./easytag.js";
import { checkTagCheckMessage } from "./tagcheck.js";

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Handles one message.
 *
 * The three features are independent, so a channel that is configured for
 * more than one of them gets all of them.
 */
export async function handleIdentityMessage(message: Message): Promise<void> {
  if (!message.guild) return;
  if (message.author.bot) return;

  const channelId = message.channelId;

  try {
    if (cache.isCachedChannel("tagcheck", channelId)) {
      await handleTagCheckMessage(message);
    }

    if (cache.isCachedChannel("easytag", channelId)) {
      await handleEasyTagMessage(message);
    }

    if (cache.isCachedChannel("ssverify", channelId)) {
      await handleSsVerifyMessage(message);
    }
  } catch (error) {
    logger.error(
      `[Identity] Could not handle the message ${message.id}: ${errorMessage(error)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Tag check
 * ------------------------------------------------------------------ */

/** How long the "you did it wrong" reply lives. */
const TAG_CHECK_REPLY_SECONDS = 5;

/** How long a rejected message lives when the channel auto-deletes. */
const TAG_CHECK_DELETE_SECONDS = 15;

/**
 * Checks a captain's message against the channel's rules.
 *
 * The rules are an ordered list of guards; the first one that refuses wins
 * (see `tagcheck.ts`). The message is reacted to either way, and the
 * team's name and players are shown when it is accepted.
 */
export async function handleTagCheckMessage(message: Message): Promise<void> {
  const config = await repo.findTagCheckByChannel(message.channelId);

  if (!config) {
    cache.uncacheChannel("tagcheck", message.channelId);

    return;
  }

  if (await isIgnored(message, config.ignoreRoleId)) return;

  const mentions = [...message.mentions.users.values()].map((user) => ({
    id: user.id,
    isBot: user.bot,
  }));

  const refusal = checkTagCheckMessage({
    requiredMentions: config.requiredMentions,
    mentions,
  });

  if (refusal) {
    await message.reply(refusal);

    await message.react("❌");

    if (config.deleteAfter) {
      scheduleDelete(message, TAG_CHECK_DELETE_SECONDS);
    }

    return;
  }

  // The team name comes from the message itself, through the ported
  // `find_team` (D27). It is not reimplemented here.
  const teamName = findTeam({
    content: message.content,
    author: message.author,
  });

  await message.react("✅");

  const players =
    mentions.length > 0
      ? mentions.map((mention) => `<@${mention.id}>`).join(", ")
      : message.author.mention;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`Team Name: ${teamName}\nPlayer(s): ${players}`);

  await message.reply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ *
 * Easy tag
 * ------------------------------------------------------------------ */

/** How long the bot's answer lives when the channel auto-deletes. */
const EASY_TAG_DELETE_SECONDS = 60;

/**
 * Turns the raw ids and `@names` in a message into real mentions.
 */
export async function handleEasyTagMessage(message: Message): Promise<void> {
  const config = await repo.findEasyTagByChannel(message.channelId);

  if (!config) {
    cache.uncacheChannel("easytag", message.channelId);

    return;
  }

  if (await isIgnored(message, config.ignoreRoleId)) return;

  const tags = extractEasyTags(message.content);

  if (tags.length === 0) {
    await message.react("❌");

    await message.reply(NO_TAG_MESSAGE);

    return;
  }

  const members: EasyTagMember[] = [
    ...message.guild.members.cache.values(),
  ].map((member) => ({
    id: member.id,
    username: member.username,
    displayName: member.displayName,
  }));

  const mentions = tags.map((tag) => {
    const memberId = resolveEasyTag(tag, members);

    return memberId ? `<@${memberId}>` : "Invalid Member!";
  });

  const answer = await message.reply(
    buildEasyTagReply(message.cleanContent, mentions),
  );

  if (config.deleteAfter) {
    scheduleDelete(message, EASY_TAG_DELETE_SECONDS);
    scheduleDelete(answer, EASY_TAG_DELETE_SECONDS);
  }
}

/* ------------------------------------------------------------------ *
 * Screenshot verification
 * ------------------------------------------------------------------ */

/** The image types the check accepts. */
const SCREENSHOT_CONTENT_TYPES = ["image/png", "image/jpeg", "image/jpg"];

/**
 * Checks the screenshots a participant posted.
 *
 * The OCR takes about two seconds per picture, so the "processing" reply
 * goes out first and the result replaces it.
 */
export async function handleSsVerifyMessage(message: Message): Promise<void> {
  const config = await repo.findSsConfigByChannel(message.channelId);

  if (!config) {
    cache.uncacheChannel("ssverify", message.channelId);

    return;
  }

  const member = message.member;

  if (member && isStaffMember(member)) return;

  const authorId = message.author.id;

  if (await service.isUserVerified(config, authorId)) {
    await message.reply(
      "**Your screenshots are already verified, kindly move onto next step.**",
    );

    return;
  }

  const attachments = message.attachments.filter(
    (attachment) =>
      attachment.contentType !== null &&
      SCREENSHOT_CONTENT_TYPES.includes(attachment.contentType),
  );

  if (attachments.size === 0) {
    await message.reply(
      "**Kindly send screenshots in `png/jpg/jpeg` format only.**",
    );

    return;
  }

  const memberWait = service.submissionLimiters.member.hit(authorId);

  if (memberWait !== null) {
    await message.reply(
      `**You are too fast. Kindly resend after \`${(memberWait / 1000).toFixed(2)} seconds\`.**`,
    );

    return;
  }

  const guildWait = service.submissionLimiters.guild.hit(message.guildId);

  if (guildWait !== null) {
    await message.reply(
      `**Many users are submitting screenshots from this server at this time. Kindly retry after \`${(guildWait / 1000).toFixed(2)} seconds\`.**`,
    );

    return;
  }

  if (attachments.size > config.requiredSs) {
    await message.reply(
      `**You only have to send \`${config.requiredSs}\` screenshots but you sent \`${attachments.size}\`**`,
    );

    return;
  }

  const processing = await message.reply(
    `Processing your ${attachments.size === 1 ? "screenshot" : "screenshots"}… ⏳`,
  );

  const images = await Promise.all(
    [...attachments.values()].map(async (attachment) => ({
      buffer: await fetchAttachment(attachment),
      channelId: message.channelId,
      messageId: message.id,
    })),
  );

  const outcome = await service.processSubmission(config, authorId, images);

  await processing.delete().catch(() => undefined);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({
      name: `Submitted ${outcome.submitted}/${config.requiredSs}`,
      iconURL: message.author.displayAvatarURL(),
    })
    .setDescription(outcome.lines.join("\n"));

  await message.reply({ embeds: [embed] });

  if (!outcome.verified) return;

  await member?.roles.add(config.roleId).catch((error: unknown) => {
    logger.warn(
      `[Identity] Could not grant the role ${config.roleId}: ${errorMessage(error)}`,
    );
  });

  if (config.successMessage) {
    const success = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Screenshot Verification Complete")
      .setURL(message.url)
      .setDescription(config.successMessage);

    await message.reply({ embeds: [success] });

    return;
  }

  await message.reply(
    `${message.author.mention} Your screenshots are verified, Move to next step.`,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Does the member hold the ignore role?
 *
 * The role is stored **by id** (D16). Quotient looked a role named
 * `quotient-tag-ignore` up on every single message.
 */
async function isIgnored(
  message: Message,
  ignoreRoleId: string | null,
): Promise<boolean> {
  if (!ignoreRoleId) return false;

  const member = message.member;

  if (!member) return false;

  return member.roles.cache.has(ignoreRoleId);
}

/**
 * Is the member staff?
 *
 * The frozen staff check: an administrator, or a member of the role named
 * "Moderator". Quotient skipped the screenshot check for anybody with a
 * role whose name *contained* `tourney-mod`, which is a name lookup (D16).
 */
export function isStaffMember(member: GuildMember): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  return member.roles.cache.some((role) => role.name === STAFF_ROLE_NAME);
}

/**
 * Downloads an attachment.
 *
 * The OCR provider takes the image's bytes, so they are fetched here.
 */
async function fetchAttachment(attachment: Attachment): Promise<Buffer> {
  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(
      `could not download the attachment ${attachment.id}: ${response.status}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Deletes something after a while.
 *
 * The timer is `unref`ed, so a pending deletion never keeps the process
 * alive.
 */
function scheduleDelete(
  target: { delete(): Promise<unknown> },
  seconds: number,
): void {
  const timer = setTimeout(() => {
    void target.delete().catch(() => undefined);
  }, seconds * 1000);

  timer.unref();
}

/**
 * The group list of a tournament, for the tourney area.
 *
 * Exposed here so the tourney area does not have to reach into this
 * module's tables.
 */
export async function publishedGroupLists(tourneyId: string) {
  return repo.listGroupLists(tourneyId);
}

/**
 * The teams of a group, for the tourney area.
 */
export async function groupTeams(
  tourneyId: string,
  groupSize: number,
  groupNumber: number,
) {
  return groups.getGroup(tourneyId, groupSize, groupNumber);
}
