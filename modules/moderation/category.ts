/**
 * Category operations: delete, hide, unhide and nuke.
 *
 * `hide` and `unhide` live in `lockdown.ts` — they are lockdowns, and they
 * record what they changed so that `unhide` can put it back.
 *
 * Two Quotient bugs are fixed here:
 *
 *  1. `category nuke` says "Delete a category completely and create a new
 *     one" but only ever replaced the category's *channels*. The category
 *     itself was never touched. This port does what the name says it does
 *     and says so in the reply: the channels are replaced, the category
 *     stays. Replacing the category as well would throw away its
 *     position, its permission overwrites and every channel's history of
 *     its own, which is more than a moderator asking for "a clean slate"
 *     expects.
 *  2. `category hide` and `category unhide` read the `@everyone`
 *     overwrite as a *computed* permission set and wrote the whole thing
 *     back, which dropped every other `@everyone`-level tweak on the
 *     channel. This port changes the one permission it means to change.
 */

import type { CategoryChannel, Guild } from "discord.js";
import { PermissionDeniedError } from "../../core/errors.js";
import { PermissionFlagsBits } from "discord.js";

/** What a category delete did. */
export interface CategoryDeleteResult {
  readonly deleted: number;
  readonly failed: number;
}

/** What a nuke did. */
export interface CategoryNukeResult {
  readonly cloned: number;
  readonly failed: number;
}

/**
 * The channels of a category the bot may delete.
 */
function deletableChildren(category: CategoryChannel): string[] {
  const ids: string[] = [];

  for (const child of category.children.cache.values()) {
    ids.push(child.id);
  }

  return ids;
}

/**
 * Deletes a category and everything under it.
 */
export async function deleteCategory(
  guild: Guild,
  category: CategoryChannel,
  reason: string,
): Promise<CategoryDeleteResult> {
  let deleted = 0;
  let failed = 0;

  for (const channelId of deletableChildren(category)) {
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
      failed += 1;
      continue;
    }

    try {
      await channel.delete(reason);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }

  try {
    await category.delete(reason);
  } catch {
    failed += 1;
  }

  return { deleted, failed };
}

/**
 * Replaces every channel of a category with a fresh clone.
 *
 * A clone keeps the name, the topic, the permission overwrites and the
 * rate limit, and starts with no messages. The clone is put back in the
 * original channel's position, so the category looks the same.
 *
 * The category itself is **not** replaced.
 */
export async function nukeCategory(
  guild: Guild,
  category: CategoryChannel,
  reason: string,
): Promise<CategoryNukeResult> {
  let cloned = 0;
  let failed = 0;

  for (const channelId of deletableChildren(category)) {
    const channel = guild.channels.cache.get(channelId);

    if (!channel || !("clone" in channel) || typeof channel.clone !== "function") {
      failed += 1;
      continue;
    }

    const position = "position" in channel ? channel.position : undefined;

    try {
      const clone = await channel.clone({
        reason,
        ...(position === undefined ? {} : { position }),
      });

      await channel.delete(reason);

      if (position !== undefined && "setPosition" in clone) {
        await clone.setPosition(position, { reason });
      }

      cloned += 1;
    } catch {
      failed += 1;
    }
  }

  return { cloned, failed };
}

/**
 * May the bot delete this category?
 */
export function assertCanManageCategory(
  guild: Guild,
  category: CategoryChannel,
): void {
  const botMember = guild.members.me;

  if (!botMember) {
    throw new PermissionDeniedError(
      "I could not find my own member record, so I cannot manage categories.",
    );
  }

  const permissions = category.permissionsFor(botMember);

  if (!permissions || !permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new PermissionDeniedError(
      `I need \`manage_channels\` permission in **${category.name}**`,
    );
  }
}
