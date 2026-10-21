/**
 * The durable jobs this area owns.
 *
 * The `tourney_open` job is a row in the `jobs` table, never a
 * `setTimeout`. A timer that dies with the process means the tournament
 * never opens again.
 *
 * The job re-arms itself for the next allowed day, so a tournament opens
 * on its own every day it is supposed to, without anybody touching the
 * bot.
 */

import type { Client } from "discord.js";
import { logger } from "../../utils/logger.js";
import { mediaPartnerChannelCache, tourneyChannelCache } from "./channel-cache.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { openTourneyInGuild } from "./views/lifecycle.js";

/** The events this area handles. */
export const TOURNEY_JOB_EVENTS = [
  repo.TOURNEY_JOB_EVENT,
  "msg_delete",
] as const;

/**
 * Handles one job.
 *
 * The shape the scheduler wants: "here is the event and the payload —
 * do your job".
 *
 * @returns whether the job belonged to this module.
 */
export async function handleTourneysJobEvent(
  client: Client,
  event: string,
  payload: unknown,
): Promise<boolean> {
  if (event === repo.TOURNEY_JOB_EVENT) {
    await onTourneyOpen(payload, client);

    return true;
  }

  if (event === "msg_delete") {
    await onMessageDelete(client, payload);

    return true;
  }

  return false;
}

/**
 * Deletes a message that was scheduled to disappear.
 *
 * The `msg_delete` event is the durable "delete this message in thirty
 * minutes" row — a `setTimeout` would die with the process and the
 * message would stay (D39).
 *
 * The payload is `{ channelId, messageId }`.
 */
export async function onMessageDelete(
  client: Client,
  payload: unknown,
): Promise<void> {
  if (typeof payload !== "object" || payload === null) return;

  const record = payload as Record<string, unknown>;

  const channelId = record.channelId;
  const messageId = record.messageId;

  if (typeof channelId !== "string" || typeof messageId !== "string") return;

  const channel = client.channels.cache.get(channelId);

  if (!channel || !("messages" in channel)) return;

  const message = await channel.messages
    .fetch(messageId)
    .catch(() => null);

  if (!message) return;

  await message.delete().catch(() => undefined);
}

/**
 * Opens a tournament on schedule.
 *
 * The job re-arms itself first, so the schedule moves on whatever
 * happens below — including when the tournament was deleted in the
 * meantime, which is when the job stops.
 *
 * **The schedule comes from the payload, not from the job row.** The
 * dispatcher deletes the row *before* it dispatches it, so by the time
 * this runs there is no row left to read the schedule from — the
 * payload is the only copy that survives the fire. Reading the row here
 * found nothing, and the tournament silently never opened.
 *
 * **The next open is derived from the schedule, not from the moment the
 * job fired.** A bot that was down for three days re-arms for the same
 * wall-clock time on the next day the tournament opens, not for "three
 * days from now". The source advanced `open_time` by exactly 24 hours
 * each fire, which drifts by the length of every outage.
 *
 * @param payload the job payload, which carries the schedule;
 * @param client  the Discord client;
 * @param now     the instant the job fired. Injectable, so a test can
 *                stand in for a bot that was down for days.
 */
export async function onTourneyOpen(
  payload: unknown,
  client: Client,
  now: Date = new Date(),
): Promise<void> {
  const tourneyId = repo.tourneyIdOf(payload);

  if (!tourneyId) return;

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await repo.deleteTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    return;
  }

  const schedule = repo.scheduleOf(payload);

  if (!schedule) return;

  // The schedule moves on, whatever happens below.
  const rearmed = await service.armOpenJob(tourneyId, schedule, now);

  if (!rearmed) return;

  if (
    !service.shouldAutoOpen({
      status: tourney.status,
      schedule,
      now,
    })
  ) {
    return;
  }

  const guild = client.guilds.cache.get(tourney.guildId);

  if (!guild) return;

  await openTourneyInGuild(guild, tourneyId);
}

/**
 * Rebuilds the channel caches from the database.
 *
 * Called at startup, so the bot does not have to ask the database about
 * every message it sees before it knows which channels accept
 * registrations.
 */
export async function rebuildChannelCache(): Promise<void> {
  await tourneyChannelCache.rebuild(async () => {
    const open = await repo.listOpenTourneys();

    return open.map((tourney) => tourney.registrationChannelId);
  });

  await mediaPartnerChannelCache.rebuild(async () => {
    const partners = await repo.listAllMediaPartners();

    return partners.map((partner) => partner.channelId);
  });

  logger.info(
    `[Tourneys] The cache holds ${tourneyChannelCache.size} registration channels and ${mediaPartnerChannelCache.size} media-partner channels.`,
  );
}
