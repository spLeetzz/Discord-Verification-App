/**
 * The block list.
 *
 * D41: the block list ships as a model, a check and a cache — **not** as a
 * chat command. The global command guard refuses blocked users and blocked
 * guilds; the management surface is an ops script, because a chat command
 * that blocks people is a chat command anybody with one permission can use
 * to lock a guild out of its own bot.
 *
 * Quotient's `bl remove` looked records up by `block_id` alone, so a user
 * and a guild that happened to share an id collided. The key here is the
 * id *and* the kind, which is also what the database's unique constraint
 * is.
 *
 * The check is served from an in-memory cache (D21): the dispatcher asks
 * on every command, and a round trip to Postgres for every command would
 * be a round trip for nothing.
 */

import { logger } from "../../utils/logger.js";
import { loadBlocklist } from "./repo.js";
import type { BlocklistEntry } from "./types.js";
import type { BlockIdType } from "./types.js";

/** The kind of id a block-list entry refers to. */
export const BLOCK_ID_TYPE = {
  /** A user. */
  user: "1",
  /** A guild. */
  guild: "2",
} as const satisfies Record<string, BlockIdType>;

/** The key an entry is stored under. */
export function blocklistKey(id: string, type: BlockIdType): string {
  return `${type}:${id}`;
}

/**
 * Where the block list is read from.
 *
 * Injected so the cache can be tested without a database.
 */
export type BlocklistLoader = () => Promise<BlocklistEntry[]>;

/**
 * The in-memory block list.
 *
 * One instance, owned by the module. It is loaded at startup and refreshed
 * on a timer, so an ops script that adds an entry takes effect within one
 * refresh interval rather than needing a restart.
 */
export class BlocklistCache {
  private readonly entries = new Map<string, BlocklistEntry>();
  private readonly load: BlocklistLoader;
  private timer: NodeJS.Timeout | null = null;

  constructor(load: BlocklistLoader = loadBlocklist) {
    this.load = load;
  }

  /**
   * Is this id blocked?
   *
   * @param type what the id refers to. The default is a user, which is
   *             what the dispatcher asks for on every command.
   */
  isBlocked(id: string, type: BlockIdType = "1"): boolean {
    return this.entries.has(blocklistKey(id, type));
  }

  /** The entry, when there is one. */
  get(id: string, type: BlockIdType = "1"): BlocklistEntry | undefined {
    return this.entries.get(blocklistKey(id, type));
  }

  /** How many entries the cache holds. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Reloads the cache from the database.
   *
   * A failure leaves the previous contents in place: a database blip must
   * not unblock everybody.
   */
  async refresh(): Promise<void> {
    try {
      const entries = await this.load();
      const next = new Map<string, BlocklistEntry>();

      for (const entry of entries) {
        next.set(blocklistKey(entry.blockId, entry.blockIdType), entry);
      }

      this.entries.clear();
      for (const [key, entry] of next) this.entries.set(key, entry);
    } catch (error) {
      logger.error(`[Moderation] Could not refresh the block list: ${String(error)}`);
    }
  }

  /**
   * Starts the periodic refresh.
   *
   * The timer is `unref`ed, so the cache never keeps the process alive on
   * its own.
   */
  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);

    this.timer.unref();
  }

  /** Stops the periodic refresh. */
  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
  }
}

/** The one block-list cache. */
export const blocklistCache = new BlocklistCache();

/**
 * Is this id blocked?
 *
 * The helper the manager's dispatcher calls: once for the user, once for
 * the guild.
 *
 * @param id   the user id or the guild id.
 * @param type what the id refers to.
 */
export async function isBlocked(
  id: string,
  type: BlockIdType = "1",
): Promise<boolean> {
  return blocklistCache.isBlocked(id, type);
}

/**
 * The same question, answered without awaiting.
 *
 * The cache is in memory, so there is nothing to wait for.
 */
export function isBlockedSync(
  id: string,
  type: BlockIdType = "1",
): boolean {
  return blocklistCache.isBlocked(id, type);
}
