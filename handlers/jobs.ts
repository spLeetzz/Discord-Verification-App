import { and, eq, lte } from "drizzle-orm";
import type { Client } from "discord.js";
import { db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { errorMessage } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * The durable job dispatcher.
 *
 * Every delayed action in this bot is a **row** in the `jobs` table: the
 * reminder, the auto-purge delete, the lockdown expiry, the premium expiry,
 * the ban expiry, the daily scrim open. Nothing that must survive a restart
 * uses `setTimeout` — a timer that dies with the process means a channel
 * stays locked forever, a reminder never fires, or a ban never lifts.
 *
 * The dispatcher **deletes the row before dispatching it**. That ordering is
 * what makes the system idempotent: if the process dies between the delete
 * and the handler finishing, the job is gone rather than firing twice. A
 * compare-and-delete on `(id, expires_at)` means a job whose time was
 * changed is not fired early.
 *
 * Quotient slept until the next job's exact expiry. Polling is close enough:
 * Discord's own timing is not precise, and a poll that is late by a second
 * is invisible to a user.
 */

/** How a job event is handled. */
export type JobHandler = (
  client: Client,
  event: string,
  payload: unknown,
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/**
 * Registers the handler for a job event.
 *
 * The event names are the ones the schema's `CHECK` constraint allows —
 * read them from `db/schema/common.ts` (`JOB_EVENTS`) rather than inventing
 * new ones.
 */
export function registerJobHandler(event: string, handler: JobHandler): void {
  handlers.set(event, handler);
}

/** The events that have a handler. Used by the startup log. */
export function registeredJobEvents(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * Dispatches one job.
 *
 * A job with no registered handler is **not** an error: an event can be
 * queued before the area that handles it is wired up. It is logged once so
 * a missing handler is visible, and the row is still deleted so the queue
 * does not grow a backlog of jobs nobody can run.
 */
export async function dispatchJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void> {
  const handler = handlers.get(event);

  if (!handler) {
    logger.warn(`[Jobs] No handler registered for "${event}" — dropping it.`);
    return;
  }

  try {
    await handler(client, event, payload);
  } catch (err) {
    logger.error(`[Jobs] Handler for "${event}" failed: ${errorMessage(err)}`);
  }
}

/** How often the dispatcher looks for due jobs. */
const POLL_INTERVAL_MS = 15_000;

let pollTimer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Claims and runs every job that is due.
 *
 * Exposed separately from the timer so it can be called directly in a test.
 */
export async function runDueJobs(client: Client): Promise<number> {
  const due = await db
    .select({
      id: jobs.id,
      event: jobs.event,
      payload: jobs.payload,
      expiresAt: jobs.expiresAt,
    })
    .from(jobs)
    .where(lte(jobs.expiresAt, new Date()))
    .limit(50);

  if (!due.length) return 0;

  let fired = 0;

  for (const job of due) {
    // Compare-and-delete: if the job's time was changed since the select,
    // the delete matches nothing and we leave it alone.
    const deleted = await db
      .delete(jobs)
      .where(and(eq(jobs.id, job.id), eq(jobs.expiresAt, job.expiresAt)))
      .returning({ id: jobs.id });

    if (!deleted.length) continue;

    fired += 1;
    await dispatchJob(client, job.event, job.payload);
  }

  return fired;
}

/**
 * Starts the dispatcher.
 *
 * The first poll runs immediately so a job that came due while the process
 * was down fires as soon as possible, rather than after one full interval.
 */
export function startJobDispatcher(client: Client): void {
  if (pollTimer) return;

  void runDueJobs(client)
    .then((count) => {
      if (count) logger.info(`[Jobs] Ran ${count} job(s) on startup.`);
    })
    .catch((err) => {
      logger.error(`[Jobs] Startup poll failed: ${errorMessage(err)}`);
    });

  pollTimer = setInterval(() => {
    if (running) return;
    running = true;

    void runDueJobs(client)
      .catch((err) => {
        logger.error(`[Jobs] Poll failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, POLL_INTERVAL_MS);

  // The dispatcher must not be the reason the process stays alive.
  pollTimer.unref?.();

  logger.info(
    `[Jobs] Dispatcher started. Events: ${registeredJobEvents().join(", ") || "none"}`,
  );
}

/** Stops the dispatcher. */
export function stopJobDispatcher(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}
