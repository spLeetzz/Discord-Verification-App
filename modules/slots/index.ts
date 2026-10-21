/**
 * The slot area's public surface.
 *
 * Another area that needs the slot manager's published slot list comes
 * through here. The one thing it must know is the rule this area
 * enforces:
 *
 *  - **the slot area owns the panel** — the buttons, their custom ids
 *    (`slots:slotlist_*`) and the edit, punish and info operations
 *    behind them;
 *  - **the scrims area owns the lifecycle** — open, close, the daily
 *    `scrim_open` job, the autoclean — and calls
 *    {@link publishSlotList} when a closed scrim has to publish its
 *    slot list.
 *
 * There is one implementation of what a published slot list looks like,
 * and it is in this area.
 *
 * ```ts
 * import { publishSlotList } from "../slots/index.js";
 *
 * const messageId = await publishSlotList(scrim.id);
 * ```
 */

export {
  buildSlotListEmbed,
  buildSlotListPanel,
  publishSlotList,
  refreshSlotListMessage,
} from "./slotlist.js";
export type { SlotListSlot } from "./views/slotlist.js";

/**
 * The fake-tag check.
 *
 * "Does any other claimed slot in this scrim already hold one of these
 * players?"
 *
 * The members of a slot live in `slot_members`, and this area owns that
 * table, so this area owns the query that reads it. The source ran it
 * as raw SQL with a Postgres array-overlap operator; as a join table it
 * is a join and an `IN`, which is faster and correct on both engines.
 *
 * The slot being checked is excluded, so a slot is never a fake tag of
 * itself.
 *
 * The scrims area's registration flow uses this to answer "has this
 * player already registered in this scrim?". It is exported here
 * because the import direction is one-way — the scrims area calls the
 * slot area, never the other way round.
 */
export { findFakeTagMatches } from "./repo.js";
export type { SlotRecord } from "./types.js";

/**
 * The ban log.
 *
 * The slot area owns the published slot list, so it owns the Punish
 * button on it, and a ban made through that button has to leave the
 * same trail a ban made anywhere else leaves. This is the writer it
 * uses: the same content the scrims area writes, from this area's own
 * code — the dependency runs the other way, so importing the scrims
 * area's writer back would be a cycle.
 */
export { buildBanLogEmbed, writeBanLog, writeBanLogs } from "./ban-log.js";
export type { BanLogAction, BanLogEntry } from "./ban-log.js";
