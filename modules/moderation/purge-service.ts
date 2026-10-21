/**
 * The Discord side of the purge.
 *
 * The rules live in `purge.ts`; this file is the adapter that fetches the
 * messages, applies the rules and calls Discord.
 *
 * The one thing that matters here: **the report is honest**. Discord
 * refuses to delete anything older than fourteen days, and Quotient's
 * `ctx.channel.purge` swallowed that with `filter_old=True`, so the
 * command said "42 messages were removed" when it had removed 30. This
 * counts the messages that were too old, the pinned ones and the ones
 * that failed, and says so.
 */

import type { GuildTextBasedChannel, Message } from "discord.js";
import {
  BULK_DELETE_BATCH_SIZE,
  PURGE_SEARCH_LIMIT,
  chunkForBulkDelete,
  matchesFilter,
  partitionByAge,
} from "./purge.js";
import type { PurgeFilter, PurgeMessage, PurgeOutcome, ReactionClearOutcome } from "./types.js";

/**
 * Clamps the number of messages to look at.
 */
export function clampSearch(search: number): number {
  if (!Number.isFinite(search)) return 100;
  if (search < 1) return 1;
  if (search > PURGE_SEARCH_LIMIT) return PURGE_SEARCH_LIMIT;

  return Math.floor(search);
}

/**
 * Turns a Discord message into the shape the rules work on.
 */
function toPurgeMessage(message: Message): PurgeMessage {
  return {
    id: message.id,
    createdAt: message.createdTimestamp,
    pinned: message.pinned,
    content: message.content,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    webhookId: message.webhookId,
    embedCount: message.embeds.length,
    attachmentCount: message.attachments.size,
    reactionCount: message.reactions.cache.reduce(
      (total, reaction) => total + reaction.count,
      0,
    ),
  };
}

/**
 * Deletes the messages a filter selects.
 *
 * @param channel the channel to purge.
 * @param filter  what to select.
 * @param search  how many messages to look at.
 */
export async function purgeMessages(input: {
  readonly channel: GuildTextBasedChannel;
  readonly filter: PurgeFilter;
  readonly search: number;
  readonly now?: number;
}): Promise<PurgeOutcome> {
  const { channel, filter } = input;
  const search = clampSearch(input.search);
  const now = input.now ?? Date.now();

  const fetched = await channel.messages.fetch({ limit: search });

  const messages = [...fetched.values()].map(toPurgeMessage);
  const matched = messages.filter((message) => matchesFilter(message, filter));

  const { deletable, tooOld } = partitionByAge(matched, now);

  // Discord's bulk delete skips pinned messages. Counting them here is
  // what makes the report honest.
  const deletableUnpinned = deletable.filter((message) => !message.pinned);
  const pinned = deletable.length - deletableUnpinned.length;

  let deleted = 0;
  let failed = 0;

  for (const batch of chunkForBulkDelete(
    deletableUnpinned,
    BULK_DELETE_BATCH_SIZE,
  )) {
    try {
      // `filterOld` is a safety net for a message that slipped past the
      // age check; the count above is what the report uses.
      const removed = await channel.bulkDelete(
        batch.map((message) => message.id),
        true,
      );
      deleted += removed.size;
    } catch {
      failed += batch.length;
    }
  }

  return { matched: matched.length, deleted, tooOld: tooOld.length, pinned, failed };
}

/**
 * Removes the reactions from the messages that have any.
 *
 * The messages themselves are not deleted — this is Quotient's
 * `clear reactions`, which is about the reactions, not the messages.
 */
export async function clearReactions(input: {
  readonly channel: GuildTextBasedChannel;
  readonly search: number;
}): Promise<ReactionClearOutcome> {
  const { channel } = input;
  const search = clampSearch(input.search);

  const fetched = await channel.messages.fetch({ limit: search });

  let scanned = 0;
  let withReactions = 0;
  let removed = 0;

  for (const message of fetched.values()) {
    scanned += 1;

    const count = message.reactions.cache.reduce(
      (total, reaction) => total + reaction.count,
      0,
    );

    if (count === 0) continue;

    withReactions += 1;
    removed += count;

    try {
      await message.reactions.removeAll();
    } catch {
      // The reactions stay. The count says what was *attempted*.
    }
  }

  return { scanned, withReactions, removed };
}
