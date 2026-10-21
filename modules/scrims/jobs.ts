/**
 * The durable jobs this area owns.
 *
 * Every one of these is a row in the `jobs` table, never a `setTimeout`.
 * A timer that dies with the process means the scrim never opens again.
 *
 *  - `scrim_open` — opens the scrim and re-arms itself for the next day;
 *  - `autoclean` — purges the channel and strips the role, and re-arms
 *    itself;
 *  - `scrim_ban` — lifts a ban whose time is up;
 *  - `scrim_reserve` — lifts a reservation whose time is up;
 *  - `scrim_match` — the match-time lock.
 *
 * The dispatcher deletes the row before it dispatches it, which makes
 * the handler idempotent under restarts.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client, Guild } from "discord.js";
import { run } from "../../core/fire-and-forget.js";
import { dayName } from "../../core/time.js";
import { logger } from "../../utils/logger.js";
import { publishSlotList, refreshSlotListMessage } from "../slots/index.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { shouldRunAutoclean } from "./schedule.js";
import { shouldAutoOpen } from "./state.js";
import { openScrimInGuild } from "./views/lifecycle.js";
import { writeBanLog } from "./views/ban-log.js";

/** The events this area handles. */
export const SCRIM_JOB_EVENTS = [
  "scrim_open",
  "autoclean",
  "scrim_ban",
  "scrim_reserve",
  "scrim_match",
] as const;

/** One of this area's job events. */
export type ScrimJobEvent = (typeof SCRIM_JOB_EVENTS)[number];

/**
 * Handles one job.
 *
 * @param event  the job's event name;
 * @param payload the job's payload, from the `jobs.payload` column.
 */
export async function handleScrimJob(
  event: string,
  payload: unknown,
  client: Client,
): Promise<void> {
  switch (event) {
    case "scrim_open":
      await onScrimOpen(payload, client);
      return;
    case "autoclean":
      await onAutoclean(payload, client);
      return;
    case "scrim_ban":
      await onScrimBan(payload, client);
      return;
    case "scrim_reserve":
      await onScrimReserve(payload);
      return;
    case "scrim_match":
      await onScrimMatch(payload, client);
      return;
    default:
      logger.warn(`[Scrims] No handler for the job event "${event}".`);
  }
}

/* ------------------------------------------------------------------ *
 * scrim_open
 * ------------------------------------------------------------------ */

/**
 * Opens a scrim at its daily time.
 *
 * The source advanced `open_time` by exactly 24 hours and armed the
 * next timer for the new time. Ours does the same, and it **re-arms**
 * even when the schedule changed while the bot was down, so a scrim
 * whose `open_time` was edited in the database still opens.
 */
export async function onScrimOpen(
  payload: unknown,
  client: Client,
): Promise<void> {
  const scrimId = repo.scrimIdOf(payload);

  if (!scrimId) return;

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  const now = new Date();

  // The schedule moves on, whatever happens below.
  const rearmed = await service.rearmDailyJob(scrim, "open");

  if (!rearmed.enabled) return;

  const today = dayName(now);

  if (
    !shouldAutoOpen({
      enabled: rearmed.enabled,
      status: rearmed.status,
      today,
      openDays: rearmed.openDays,
    })
  ) {
    return;
  }

  const guild = client.guilds.cache.get(rearmed.guildId);

  if (!guild) return;

  await openScrimInGuild(guild, rearmed.id);
}

/* ------------------------------------------------------------------ *
 * autoclean
 * ------------------------------------------------------------------ */

/**
 * The daily autoclean pass.
 *
 * Two independent toggles: purge the registration channel, and strip
 * the success role from everybody who holds it — except the owners of
 * reserved slots, who keep it.
 *
 * The pass only runs while the scrim closed **less than 48 hours ago**.
 */
export async function onAutoclean(
  payload: unknown,
  client: Client,
): Promise<void> {
  const scrimId = repo.scrimIdOf(payload);

  if (!scrimId) return;

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  const rearmed = await service.rearmDailyJob(scrim, "autoclean");

  if (!rearmed.enabled) return;

  const now = new Date();

  if (!shouldRunAutoclean({ closedAt: rearmed.closedAt, now })) return;

  const guild = client.guilds.cache.get(rearmed.guildId);

  if (!guild) return;

  if (rearmed.autoclean.includes("channel")) {
    await purgeChannel(guild, rearmed.registrationChannelId);
  }

  if (rearmed.autoclean.includes("role")) {
    await stripRole(guild, rearmed);
  }
}

/** Purges the registration channel, leaving the pinned messages. */
export async function purgeChannel(
  guild: Guild,
  channelId: string,
): Promise<void> {
  const channel = guild.channels.cache.get(channelId);

  if (!channel || channel.type !== ChannelType.GuildText) return;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);

  if (!messages) return;

  const doomed = [...messages.values()]
    .filter((message) => !message.pinned)
    .filter((message) => message.author.id !== guild.client.user.id);

  if (doomed.length === 0) return;

  await channel.bulkDelete(doomed.slice(0, 100), true).catch(() => undefined);
}

/**
 * Strips the success role from everybody who holds it.
 *
 * The owners of reserved slots keep it: their slot was set aside, so
 * the role is still theirs.
 */
export async function stripRole(
  guild: Guild,
  scrim: { id: string; roleId: string | null },
): Promise<void> {
  if (!scrim.roleId) return;

  const role = guild.roles.cache.get(scrim.roleId);

  if (!role) return;

  const me = guild.members.me;

  if (!me) return;

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return;

  if (role.position >= me.roles.highest.position) return;

  const reserved = await repo.listReservedSlots(scrim.id);
  const keep = new Set(
    reserved.map((slot) => slot.userId).filter((id): id is string => !!id),
  );

  for (const member of role.members.values()) {
    if (keep.has(member.id)) continue;

    await member.roles.remove(role).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * scrim_ban
 * ------------------------------------------------------------------ */

/** Lifts the bans whose time is up. */
export async function onScrimBan(
  payload: unknown,
  client: Client,
): Promise<void> {
  const scrimIds = repo.allScrimIdsOf(payload);
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

/* ------------------------------------------------------------------ *
 * scrim_reserve
 * ------------------------------------------------------------------ */

/** Lifts the reservations whose time is up. */
export async function onScrimReserve(payload: unknown): Promise<void> {
  const scrimId = repo.scrimIdOf(payload);

  if (!scrimId) return;

  await repo.deleteReservedSlots(scrimId);
  await repo.deleteScrimJobs("scrim_reserve", scrimId);
}

/* ------------------------------------------------------------------ *
 * scrim_match
 * ------------------------------------------------------------------ */

/**
 * The match-time lock.
 *
 * At the match time the scrim's slots stop being claimable, so nobody
 * can cancel or claim after the match has started.
 */
export async function onScrimMatch(
  payload: unknown,
  client: Client,
): Promise<void> {
  const scrimId = repo.scrimIdOf(payload);

  if (!scrimId) return;

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  const slots = await repo.listSlots(scrim.id);

  for (const slot of slots) {
    if (slot.state !== "claimed") continue;

    await repo.setSlotState(slot.id, "locked").catch(() => undefined);
  }

  const guild = client.guilds.cache.get(scrim.guildId);

  if (!guild) return;

  const channel = guild.channels.cache.get(scrim.slotlistChannelId);

  if (!channel || !("send" in channel)) return;

  await channel
    .send({
      content: `🔒 The match for **${scrim.name}** has started. The slot list is now locked.`,
    })
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Rebuilds the registration-channel cache from the database.
 *
 * Called at startup, so the bot does not have to ask the database about
 * every message it sees before it knows which channels accept
 * registrations.
 *
 * The cache owns the invalidation (D21); this function is the area's
 * query, handed to it.
 */
export async function rebuildChannelCache(): Promise<void> {
  await service.scrimChannelCache.rebuild(async () => {
    const scrims = await repo.listOpenScrims();

    return scrims.map((scrim) => scrim.registrationChannelId);
  });
}

/**
 * Refreshes a published slotlist message.
 *
 * The slot area owns the published message: it finds it through the
 * scrim row that holds its id and re-renders it. This function only
 * decides that a refresh is due.
 */
export async function refreshPublishedSlotlist(scrimId: string): Promise<void> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim?.slotlistMessageId) return;

  await refreshSlotListMessage(scrim.slotlistMessageId);
}

/**
 * Publishes a scrim's slot list.
 *
 * The slot area publishes it: it renders the body, the panel and the
 * message id, and it records the id in `scrims.slotlist_message_id`.
 * **This area does not write that column** — one writer, or whichever
 * re-renders last wins.
 *
 * There is nothing to publish when no team has claimed a slot; the
 * publisher answers `null` rather than throwing, so there is no guard
 * here.
 */
export async function publishAndStore(scrimId: string): Promise<void> {
  const messageId = await publishSlotList(scrimId);

  if (!messageId) return;

  logger.info(
    `[Scrims] Published the slot list ${messageId} of the scrim ${scrimId}.`,
  );
}

/** Runs a background job without letting it crash the process. */
export function background(fn: () => Promise<unknown>, label: string): void {
  run(fn, label);
}

/** The cache the listeners use. */
export { scrimChannelCache } from "./service.js";
