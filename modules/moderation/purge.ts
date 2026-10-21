/**
 * The purge rules.
 *
 * These are the pure parts of `/clear`: which messages a filter selects,
 * which of them Discord will actually let us delete, and how the deletes
 * are batched.
 *
 * Two Discord limits shape everything here:
 *
 *  - `bulkDelete` takes **at most 100 messages** per call, so the deletes
 *    are chunked;
 *  - it **refuses anything older than 14 days**, and it refuses the whole
 *    batch when one message in it is too old. Quotient's `ctx.channel.purge`
 *    swallowed that with `filter_old=True` and reported a number that was
 *    quietly smaller than the number it had been asked to remove. This port
 *    filters the old messages out first and *reports* them (D44).
 */

import type { PurgeFilter, PurgeMessage } from "./types.js";

/** The most messages a purge will look at. */
export const PURGE_SEARCH_LIMIT = 2000;

/** Discord's bulk-delete endpoint takes at most 100 messages per call. */
export const BULK_DELETE_BATCH_SIZE = 100;

/** Discord refuses to delete messages older than fourteen days. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The shortest substring `contains` will look for. */
export const CONTAINS_MIN_LENGTH = 3;

/**
 * A custom emoji in message content.
 *
 * Ported from Quotient's `mod/__init__.py:122`, including the character
 * class: an optional `a` for the animated form, a name of letters, digits
 * and underscores, and the snowflake.
 */
export const CUSTOM_EMOJI_PATTERN = /<a?:[a-zA-Z0-9_]+:([0-9]+)>/;

/**
 * Does this message match the filter?
 *
 * The rules are Quotient's:
 *
 *  - `all` skips pinned messages, because bulk delete cannot remove them;
 *  - `embeds` / `files` / `images` look at the attachment counts;
 *  - `user` compares the author;
 *  - `contains` is a plain substring search;
 *  - `bot` matches a bot's own messages but *not* a bot's webhooks, unless
 *    the message starts with the given prefix;
 *  - `emoji` looks for a custom emoji in the content;
 *  - `reactions` matches anything that carries a reaction.
 */
export function matchesFilter(
  message: PurgeMessage,
  filter: PurgeFilter,
): boolean {
  switch (filter.kind) {
    case "all":
      return !message.pinned;
    case "embeds":
      return message.embedCount > 0;
    case "files":
      return message.attachmentCount > 0;
    case "images":
      return message.embedCount > 0 || message.attachmentCount > 0;
    case "user":
      return message.authorId === filter.userId;
    case "contains":
      return message.content.includes(filter.text);
    case "bot":
      return (
        (message.webhookId === null && message.authorIsBot) ||
        (filter.prefix !== null && message.content.startsWith(filter.prefix))
      );
    case "emoji":
      return CUSTOM_EMOJI_PATTERN.test(message.content);
    case "reactions":
      return message.reactionCount > 0;
  }
}

/**
 * Is this message too old for Discord to delete?
 *
 * Discord's rule is "older than two weeks", so a message exactly at the
 * boundary is still deletable.
 */
export function isTooOld(
  message: { readonly createdAt: number },
  now: number,
): boolean {
  return now - message.createdAt > BULK_DELETE_MAX_AGE_MS;
}

/** The result of splitting a message list by age. */
export interface AgePartition<T> {
  /** The messages Discord will let us delete. */
  readonly deletable: T[];
  /** The messages that are too old. */
  readonly tooOld: T[];
}

/**
 * Splits a list of messages into the ones Discord will delete and the ones
 * it will not.
 *
 * @param now the current instant, in milliseconds since the epoch.
 */
export function partitionByAge<T extends { readonly createdAt: number }>(
  messages: readonly T[],
  now: number,
): AgePartition<T> {
  const deletable: T[] = [];
  const tooOld: T[] = [];

  for (const message of messages) {
    if (isTooOld(message, now)) {
      tooOld.push(message);
    } else {
      deletable.push(message);
    }
  }

  return { deletable, tooOld };
}

/**
 * Splits a list into batches of at most `size` entries.
 *
 * Discord's bulk delete takes 100 messages per call, and a batch with one
 * message too old fails as a whole — so the batches are cut *after* the
 * age filter, never before it.
 */
export function chunkForBulkDelete<T>(
  messages: readonly T[],
  size: number = BULK_DELETE_BATCH_SIZE,
): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be positive");

  const chunks: T[][] = [];

  for (let index = 0; index < messages.length; index += size) {
    chunks.push(messages.slice(index, index + size));
  }

  return chunks;
}

/**
 * Checks the `contains` filter's minimum length.
 *
 * @returns the refusal message, or `null` when the substring is long
 *          enough.
 */
export function validateContains(text: string): string | null {
  if (text.length < CONTAINS_MIN_LENGTH) {
    return `The substring length must be at least ${CONTAINS_MIN_LENGTH} characters.`;
  }

  return null;
}
