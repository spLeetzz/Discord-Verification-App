/**
 * The public interface of the moderation area.
 *
 * The manager wires two things:
 *
 * ```ts
 * // the router
 * registerModerationInteractions(router);
 *
 * // the startup
 * await startModeration();
 * ```
 *
 * and one thing it calls on every command:
 *
 * ```ts
 * if (await isBlocked(interaction.user.id, "1")) return;
 * if (interaction.guildId && await isBlocked(interaction.guildId, "2")) return;
 * ```
 */

import { logger } from "../../utils/logger.js";
import { blocklistCache } from "./blocklist.js";

export {
  blocklistCache,
  BLOCK_ID_TYPE,
  isBlocked,
  isBlockedSync,
} from "./blocklist.js";

export {
  handleModerationInteraction,
  registerModerationInteractions,
} from "./views/interactions.js";

export { handleLockdownJob, handleModerationJob } from "./jobs.js";

/**
 * Loads the block list and starts keeping it fresh.
 *
 * The manager calls this once, from the startup path.
 */
export async function startModeration(): Promise<void> {
  await blocklistCache.refresh();
  blocklistCache.start();

  logger.info(
    `[Moderation] Block list loaded: ${blocklistCache.size} entr${blocklistCache.size === 1 ? "y" : "ies"}.`,
  );
}

/**
 * Stops the block list's refresh timer.
 */
export function stopModeration(): void {
  blocklistCache.stop();
}
