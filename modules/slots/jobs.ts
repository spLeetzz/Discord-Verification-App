/**
 * The ban expiry.
 *
 * A ban with a duration is a row in `banned_teams` with an `expires`
 * column, and something has to lift it when the time is up. The
 * scheduler is the `jobs` table — never a `setTimeout`, because a timer
 * that dies with the process means the ban lasts forever.
 *
 * The event is `scrim_ban` and the payload is `{ scrimIds, userIds }` —
 * the shape `repo.scheduleBanExpiry` writes. The scrims area arms the
 * same event for the bans it makes, with a superset of that payload, so
 * this handler reads both.
 *
 * **An expired ban leaves the same trail a manual unban does.** The
 * moderator who reads the log wants the whole history: the ban that was
 * applied and the ban that ran out are both in it.
 *
 * The write never fails the unban. The ban row is already gone by the
 * time the log is written, and a ban that is lifted but not logged is a
 * hole in the audit trail, not a refused unban.
 */

import type { Client } from "discord.js";
import { logger } from "../../utils/logger.js";
import { writeBanLog } from "./ban-log.js";
import * as repo from "./repo.js";

/** The job events this area handles. */
export const SLOTS_JOB_EVENTS = ["scrim_ban"] as const;

/** One of this area's job events. */
export type SlotsJobEvent = (typeof SLOTS_JOB_EVENTS)[number];

/**
 * Handles one job.
 *
 * The manager's registry calls this with the event name and the payload
 * of the row that came due.
 *
 * @param event   the job's event name;
 * @param payload the job's payload, from the `jobs.payload` column;
 * @param client  the client, to find the guild the scrim belongs to.
 */
export async function handleSlotsJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void> {
  if (event !== "scrim_ban") {
    logger.warn(`[Slots] No handler for the job event "${event}".`);
    return;
  }

  await onScrimBan(payload, client);
}

/**
 * Lifts the bans whose time is up.
 *
 * The payload names the scrims and the users, and the ban is the pair:
 * every user is lifted from every scrim, which is what the payload
 * means — the punish that armed the job banned those members from
 * those scrims.
 */
export async function onScrimBan(
  payload: unknown,
  client: Client,
): Promise<void> {
  const scrimIds = repo.scrimIdsOf(payload);
  const userIds = repo.userIdsOf(payload);

  if (scrimIds.length === 0 || userIds.length === 0) return;

  for (const scrimId of scrimIds) {
    const scrim = await repo.getScrim(scrimId);

    const guild = client.guilds.cache.get(scrim?.guildId ?? "");

    for (const userId of userIds) {
      await repo.unbanUser(scrimId, userId);

      // The ban ran out on its own. It still goes in the log: the
      // moderator who reads it wants to see the whole history.
      if (guild && scrim) {
        await writeBanLog(guild, {
          action: "unbanned",
          userId,
          scrimName: scrim.name,
          reason: null,
          expires: null,
          moderatorId: null,
        });
      }
    }
  }
}
