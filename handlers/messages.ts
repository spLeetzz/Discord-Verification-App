import { ChannelType } from "discord.js";
import type { Message, PrivateThreadChannel } from "discord.js";
import { getEventByChannelId } from "../config/events.js";
import { isBlocked, BLOCK_ID_TYPE } from "../modules/moderation/register.js";
import { errorMessage } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Picks the users a mention should add to a ticket thread.
 *
 * Pure so it can be tested without a Discord connection.
 */
export function selectMembersToAdd(
  existingMemberIds: Iterable<string>,
  mentionedUserIds: Iterable<string>,
  authorId: string,
): string[] {
  const existing = new Set(existingMemberIds);
  const selected: string[] = [];

  for (const id of mentionedUserIds) {
    // The author is already in the thread, and nobody is added twice.
    if (id === authorId) continue;
    if (existing.has(id)) continue;
    if (selected.includes(id)) continue;

    selected.push(id);
  }

  return selected;
}

/**
 * The answer to a mention.
 *
 * Short, and it says the one thing a member who typed at the bot needs:
 * that it is here, and that its commands are slash commands.
 */
async function answerMention(message: Message): Promise<void> {
  try {
    await message.reply({
      content:
        "I am here. My commands are slash commands — type `/` and pick one. " +
        "In a verification ticket, mention the players you want added and I will add them.",
      allowedMentions: { users: [] },
    });
  } catch (err) {
    logger.warn(`[Message] Could not answer the mention: ${errorMessage(err)}`);
  }
}

/**
 * Ticket threads are private, so a mention on its own does not let anyone
 * else see the thread. When the captain mentions his players, the bot adds
 * them to the thread so they can post their own IGN, UID and screenshots.
 */
export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  // A blocked member is blocked everywhere, not only where they can type a
  // command. The message listener is how a captain adds players to a
  // private ticket thread, so a blocked user could otherwise keep pulling
  // people into threads.
  if (await isBlocked(message.author.id, BLOCK_ID_TYPE.user)) return;
  if (
    message.guildId &&
    (await isBlocked(message.guildId, BLOCK_ID_TYPE.guild))
  ) {
    return;
  }

  const channel = message.channel;

  /**
   * **A mention is answered.**
   *
   * The original bot greeted anyone who mentioned it and told them the
   * prefix. Ours said nothing at all, so a member who typed at the bot
   * in the registration channel got silence and no way to tell that it
   * was even there.
   *
   * The answer says what the bot is and how to use it, because the
   * commands are slash commands and a mention is the one place a member
   * can ask.
   */
  if (message.mentions.users.has(message.client.user.id)) {
    await answerMention(message);

    return;
  }

  if (channel.type !== ChannelType.PrivateThread) return;

  const thread = channel as PrivateThreadChannel;

  // Only tickets of a configured verification channel.
  const parentId = thread.parentId;

  if (!parentId) return;
  if (!getEventByChannelId(parentId)) return;

  const mentioned = [...message.mentions.users.values()];

  if (!mentioned.length) return;

  let existingIds: string[];

  try {
    const members = await thread.members.fetch();
    existingIds = [...members.keys()];
  } catch (err) {
    logger.warn(
      `[Message] Could not read thread members for ${thread.id}: ${errorMessage(err)}`,
    );
    return;
  }

  const toAdd = selectMembersToAdd(
    existingIds,
    mentioned.map((user) => user.id),
    message.author.id,
  );

  if (!toAdd.length) return;

  const added: string[] = [];

  for (const userId of toAdd) {
    try {
      await thread.members.add(userId);
      added.push(userId);
    } catch (err) {
      logger.warn(
        `[Message] Could not add ${userId} to thread ${thread.id}: ${errorMessage(err)}`,
      );
    }
  }

  if (!added.length) return;

  const mentions = added.map((id) => `<@${id}>`).join(", ");

  await thread
    .send(
      `👋 ${mentions} ${added.length === 1 ? "has" : "have"} been added to this ticket by ${message.author}.`,
    )
    .catch((err) => {
      logger.warn(
        `[Message] Could not post the join notice in ${thread.id}: ${errorMessage(err)}`,
      );
    });
}
