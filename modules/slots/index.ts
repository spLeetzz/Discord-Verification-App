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
