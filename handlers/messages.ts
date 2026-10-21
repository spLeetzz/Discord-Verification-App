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
