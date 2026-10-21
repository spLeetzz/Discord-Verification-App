/**
 * The durable jobs this area owns.
 *
 * Every one of these is a row in the `jobs` table, never a `setTimeout`.
 * A timer that dies with the process means a reminder never fires, a
 * message is never deleted or a channel is locked forever.
 *
 *  - `reminder` — posts a reminder in the channel it was created in;
 *  - `autopurge` — deletes one message once its channel's delay is up;
 *  - `community_daily` — the daily housekeeping pass.
 *
 * Each event means exactly one thing, and the payload says nothing about
 * *which* event it is: the event name says it.
 *
 * The dispatcher deletes the row before it dispatches it, which makes the
 * handler idempotent under restarts: a job that fires twice cannot post
 * two reminders, because the second time there is no row to fire.
 */

import type { Client } from "discord.js";
import { pruneCommandUsage } from "../../db/retention.js";
import { logger } from "../../utils/logger.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { deliverReminder } from "./views/reminder.js";
import type { AutoPurgeJobPayload, ReminderJobPayload } from "./types.js";

/** The job events this area owns. */
export const COMMUNITY_JOB_EVENTS = [
  "reminder",
  "autopurge",
  "community_daily",
] as const;

/** One of this area's job events. */
export type CommunityJobEvent = (typeof COMMUNITY_JOB_EVENTS)[number];

/** How long a snipe is kept. */
export const SNIPE_RETENTION_DAYS = 10;

/** How often the daily housekeeping pass runs, in milliseconds. */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The id of the daily housekeeping row.
 *
 * The daily pass is a **singleton**: one row, one known id. The row is
 * what the scheduler picks up, and the id is how the area finds and
 * replaces it — so "there is exactly one daily row" is a fact about the
 * primary key rather than a convention about deleting every row of an
 * event.
 *
 * The id is a fixed uuid, not a fresh one per run: the daily job is a
 * named thing, and a reader of the `jobs` table can recognise it.
 */
export const DAILY_JOB_ID = "00000000-0000-4000-8000-00000000da17";

/**
 * Handles one job.
 *
 * The shape a dispatcher wants: "here is the event and the payload — do
 * you handle it?". An event this area does not own is ignored, quietly:
 * every area's handler sees every event, and a warning per unknown event
 * would be noise.
 */
export async function handleCommunityJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void> {
  await handleCommunityJobEvent(client, event, payload);
}

/**
 * Handles one job and says whether it was this area's.
 *
 * The boolean form is for a dispatcher that walks a list of areas and
 * stops at the first one that owns the event. {@link handleCommunityJob}
 * is the same thing without the answer.
 *
 * @returns whether the job belonged to this area.
 */
export async function handleCommunityJobEvent(
  client: Client,
  event: string,
  payload: unknown,
): Promise<boolean> {
  switch (event) {
    case "reminder":
      await onReminder(client, payload);
      return true;
    case "autopurge":
      await onAutoPurge(client, payload);
      return true;
    case "community_daily":
      await onCommunityDaily(payload);
      return true;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * reminder
 * ------------------------------------------------------------------ */

/**
 * Reads a reminder payload.
 *
 * @returns the payload, or `null` when the row does not hold one.
 */
export function parseReminderPayload(
  payload: unknown,
): ReminderJobPayload | null {
  if (typeof payload !== "object" || payload === null) return null;

  const candidate = payload as Record<string, unknown>;

  const channelId = candidate["channelId"];
  const userId = candidate["userId"];
  const message = candidate["message"];

  if (typeof channelId !== "string" || !channelId) return null;
  if (typeof userId !== "string" || !userId) return null;
  if (typeof message !== "string") return null;

  const sourceMessageId = candidate["sourceMessageId"];
  const reminderId = candidate["reminderId"];
  const createdAt = candidate["createdAt"];

  return {
    channelId,
    userId,
    message,
    ...(typeof sourceMessageId === "string" && sourceMessageId
      ? { sourceMessageId }
      : {}),
    ...(typeof reminderId === "string" && reminderId ? { reminderId } : {}),
    ...(typeof createdAt === "string" && createdAt ? { createdAt } : {}),
  };
}

/**
 * Posts a reminder.
 *
 * The reminder goes to the channel it was created in. When that channel
 * is gone, the reminder is dropped and the drop is logged.
 */
export async function onReminder(
  client: Client,
  payload: unknown,
): Promise<void> {
  const parsed = parseReminderPayload(payload);

  if (!parsed) {
    logger.warn("[Community] A reminder job had no usable payload. Dropping it.");
    return;
  }

  const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : new Date();

  await deliverReminder(client, parsed, {
    reminderId: parsed.reminderId ?? "unknown",
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
  });
}

/* ------------------------------------------------------------------ *
 * autopurge
 * ------------------------------------------------------------------ */

/**
 * Reads an auto-purge payload.
 *
 * @returns the payload, or `null` when the row does not hold one.
 */
export function parseAutoPurgePayload(
  payload: unknown,
): AutoPurgeJobPayload | null {
  if (typeof payload !== "object" || payload === null) return null;

  const candidate = payload as Record<string, unknown>;

  const channelId = candidate["channelId"];
  const messageId = candidate["messageId"];

  if (typeof channelId !== "string" || !channelId) return null;
  if (typeof messageId !== "string" || !messageId) return null;

  return { channelId, messageId };
}

/**
 * Deletes the message an `autopurge` job is about.
 *
 * The event means one thing and one thing only: "delete this message
 * after this delay". The daily housekeeping pass has an event of its
 * own (`community_daily`), so there is no payload kind to tell two
 * kinds of work apart.
 *
 * A row left over from before that change — an `autopurge` row whose
 * payload says `kind: "daily"` — has no channel and no message, so it
 * is dropped with a warning and the new daily row takes over.
 */
export async function onAutoPurge(
  client: Client,
  payload: unknown,
): Promise<void> {
  const parsed = parseAutoPurgePayload(payload);

  if (!parsed) {
    logger.warn(
      "[Community] An auto-purge job had no usable payload. Dropping it.",
    );
    return;
  }

  const config = await service.getAutoPurgeConfig(parsed.channelId);

  if (!config) return;

  // The cache first: fetching a channel is an API call, and this runs
  // once per deleted message.
  const channel =
    client.channels.cache.get(parsed.channelId) ??
    (await client.channels.fetch(parsed.channelId).catch(() => null));

  if (!channel || !channel.isTextBased() || channel.isDMBased()) return;

  const message = await channel.messages
    .fetch(parsed.messageId)
    .catch(() => null);

  if (!message) return;

  // A pinned message is not deleted. The source kept its pins too.
  if (message.pinned) return;

  await message.delete().catch((error: unknown) => {
    logger.warn(
      `[Community] Could not delete the auto-purged message ${parsed.messageId}: ${String(error)}`,
    );
  });
}

/* ------------------------------------------------------------------ *
 * The daily housekeeping pass
 * ------------------------------------------------------------------ */

/**
 * Runs the daily housekeeping pass.
 *
 * Two prunes:
 *
 *  - the snipes that are older than ten days. The source pruned them
 *    **once at startup**, which is a one-shot task and not a loop, so the
 *    rows accumulated for weeks. This runs every day;
 *  - the command-usage rows that are older than thirty days (S10).
 *
 * Both are deletes, so the pass is idempotent: running it twice in a row
 * removes nothing the second time.
 *
 * The pass has no arguments, so the payload is empty. The event name is
 * the whole message.
 */
export async function onCommunityDaily(payload: unknown): Promise<void> {
  void payload;

  try {
    const snipes = await service.pruneSnipes(SNIPE_RETENTION_DAYS);
    const usage = await pruneCommandUsage();

    logger.info(
      `[Community] Daily maintenance: ${snipes} snipe(s) and ${usage} command-usage row(s) removed.`,
    );
  } catch (error) {
    logger.error(
      `[Community] The daily maintenance pass failed: ${String(error)}`,
    );
  }

  // The next run is armed here, in the database. A timer would die with
  // the process, and a daily sweep that only runs until the next restart
  // is not a daily sweep.
  try {
    await rearmDailyJob();
  } catch (error) {
    logger.error(
      `[Community] The daily pass could not arm its next run: ${String(error)}`,
    );
  }
}

/**
 * Makes sure there is exactly one daily housekeeping row, due tomorrow.
 *
 * The row is replaced rather than added, so the pass cannot end up
 * running twice a day after a restart. Only the daily row is touched:
 * the message-deletion rows are other people's business.
 */
export async function rearmDailyJob(now: Date = new Date()): Promise<void> {
  await repo.deleteJob(DAILY_JOB_ID);

  await repo.insertJob({
    id: DAILY_JOB_ID,
    expiresAt: new Date(now.getTime() + DAILY_INTERVAL_MS),
    event: "community_daily",
    payload: {},
  });
}

/**
 * Makes sure the daily housekeeping row exists.
 *
 * Called at startup: without it the pass would never run, because the
 * row is what the scheduler picks up. It also heals a pass whose re-arm
 * failed while the process was up.
 */
export async function ensureDailyJob(now: Date = new Date()): Promise<void> {
  const existing = await repo.findJob(DAILY_JOB_ID);

  if (existing) return;

  await repo.insertJob({
    id: DAILY_JOB_ID,
    expiresAt: new Date(now.getTime() + DAILY_INTERVAL_MS),
    event: "community_daily",
    payload: {},
  });
}

/**
 * Prunes the command-usage log.
 *
 * The daily pass calls this itself. It is exported as well, so the
 * manager can wire it to a cron of its own if it prefers — the prune is
 * idempotent, so running it twice deletes nothing the second time.
 *
 * @returns how many rows were removed.
 */
export async function handleRetentionJob(): Promise<number> {
  return pruneCommandUsage();
}
