/**
 * The daily jobs: `scrim_open` and `autoclean`.
 *
 * Both are rows in the durable `jobs` table, never a `setTimeout`. A timer
 * that dies with the process means the scrim never opens again.
 *
 * The source's re-arm was (`src/cogs/esports/events/scrims.py:111-151`):
 *
 * ```python
 * if scrim.open_time != timer.expires:  # a stale timer
 *     return
 * await Scrim.filter(pk=scrim.id).update(open_time=scrim.open_time + timedelta(hours=24))
 * await self.bot.reminders.create_timer(scrim.open_time + timedelta(hours=24), "scrim_open", scrim_id=scrim.id)
 * ```
 *
 * Note that the new timer is armed at the **new** `open_time`, and the
 * advance is exactly 24 hours — not "tomorrow at the same wall-clock
 * time", which is what a naive re-arm would compute.
 */

/** A day, in milliseconds. India has no daylight saving, so it is exact. */
export const DAY_MS = 86_400_000;

/** How long before a closed scrim stops being autocleaned. */
export const AUTOCLEAN_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * The next occurrence of a daily job.
 *
 * @param current the instant the job was armed for.
 * @returns the same instant, 24 hours later.
 */
export function nextDailyInstant(current: Date): Date {
  return new Date(current.getTime() + DAY_MS);
}

/**
 * Is a job stale?
 *
 * The source compared `scrim.open_time` with `timer.expires` and did
 * nothing when they differed: the editor re-arms the timer whenever it
 * changes `open_time`, so a mismatch means the job belongs to a schedule
 * that no longer exists.
 *
 * The port does the same thing, but it *re-arms* rather than giving up:
 * a stale job is dropped and a fresh one is armed for the scrim's
 * current time, so a scrim whose schedule was edited while the bot was
 * down still opens.
 */
export function isStaleJob(scheduleTime: Date, jobExpiresAt: Date): boolean {
  return scheduleTime.getTime() !== jobExpiresAt.getTime();
}

/**
 * The new schedule after a daily job fires.
 *
 * @returns the new `open_time` (or `autoclean_time`) and the instant the
 *          next job should fire.
 */
export function nextDailySchedule(current: Date): {
  nextTime: Date;
  nextRunAt: Date;
} {
  const nextTime = nextDailyInstant(current);

  return { nextTime, nextRunAt: nextTime };
}

/**
 * Should the autoclean pass run?
 *
 * The source only autocleaned a scrim that closed **less than 48 hours
 * ago**:
 *
 * ```python
 * if scrim.closed_at and scrim.closed_at < self.bot.current_time - timedelta(hours=48):
 *     return
 * ```
 *
 * A scrim that was never closed always autocleans.
 */
export function shouldRunAutoclean(options: {
  readonly closedAt: Date | null;
  readonly now: Date;
}): boolean {
  const { closedAt, now } = options;

  if (!closedAt) return true;

  return closedAt.getTime() >= now.getTime() - AUTOCLEAN_GRACE_MS;
}

/**
 * The next `match_time`.
 *
 * The source's `ensure_match_timer` rolled the match time forward by a
 * whole day until it was in the future, and only then armed the
 * `scrim_match` job.
 */
export function nextMatchTime(current: Date, now: Date): Date {
  let next = current.getTime();

  while (next <= now.getTime()) {
    next += DAY_MS;
  }

  return new Date(next);
}
