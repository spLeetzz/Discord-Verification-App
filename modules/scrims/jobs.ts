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
import type { Client, Guild, TextBasedChannel } from "discord.js";
import { run } from "../../core/fire-and-forget.js";
import { dayName } from "../../core/time.js";
import { logger } from "../../utils/logger.js";
import { scrimChannelCache } from "./channel-cache.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { shouldRunAutoclean } from "./schedule.js";
import { shouldAutoOpen } from "./state.js";
import { publishSlotlist, refreshSlotlistMessage } from "./views/slotlist.js";

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
      await onScrimBan(payload);
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

/** Opens a scrim and posts its open message. */
export async function openScrimInGuild(
  guild: Guild,
  scrimId: string,
): Promise<void> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  let result: service.OpenResult;

  try {
    result = await service.openRegistration(scrim.id);
  } catch (error) {
    logger.error(
      `[Scrims] Could not open the scrim ${scrim.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return;
  }

  const fresh = result.scrim;
  const channel = guild.channels.cache.get(fresh.registrationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) return;

  const { renderOpenMessage } = await import("./render.js");

  const reserved = await repo.listReservedSlots(fresh.id);

  const embed = renderOpenMessage(fresh, {
    mentions: fresh.requiredMentions,
    totalSlots: fresh.totalSlots,
    reservedCount: reserved.length,
    slotlistMention: `<#${fresh.slotlistChannelId}>`,
    multiregister: fresh.multiregister,
    teamnameCompulsion: fresh.teamnameCompulsion,
    bannedMentions: "",
    reservedMentions: reserved
      .filter((slot) => slot.userId)
      .map((slot) => `<@${slot.userId}>`)
      .join(", "),
  });

  await channel.send({ embeds: [embed] }).catch(() => undefined);
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

  const doomed = messages
    .filter((message) => !message.pinned)
    .filter((message) => message.author.id !== guild.client.user.id)
    .filter((message) => message.id !== guild.client.user.id);

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
export async function onScrimBan(payload: unknown): Promise<void> {
  const scrimIds = repo.allScrimIdsOf(payload);
  const userIds = repo.userIdsOf(payload);

  if (scrimIds.length === 0 || userIds.length === 0) return;

  for (const scrimId of scrimIds) {
    for (const userId of userIds) {
      await repo.unbanUser(scrimId, userId);
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
 */
export async function rebuildChannelCache(): Promise<void> {
  const scrims = await repo.listOpenScrims();

  scrimChannelCache.replace(
    scrims.map((scrim) => scrim.registrationChannelId),
  );
}

/** The channel a scrim's slotlist lives in. */
export function slotlistChannel(
  guild: Guild,
  channelId: string,
): TextBasedChannel | null {
  const channel = guild.channels.cache.get(channelId);

  if (!channel) return null;

  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return null;
  }

  return channel as TextBasedChannel;
}

/** Refreshes a published slotlist message. */
export async function refreshPublishedSlotlist(
  guild: Guild,
  scrimId: string,
): Promise<void> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim || !scrim.slotlistMessageId) return;

  const channel = slotlistChannel(guild, scrim.slotlistChannelId);

  if (!channel) return;

  const slots = await repo.listSlots(scrim.id);

  await refreshSlotlistMessage(channel, scrim, slots);
}

/** Publishes a slotlist and stores its message id. */
export async function publishAndStore(
  guild: Guild,
  scrimId: string,
): Promise<void> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return;

  const channel = slotlistChannel(guild, scrim.slotlistChannelId);

  if (!channel) return;

  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) return;

  const message = await publishSlotlist(channel, scrim, claimed);

  await repo.updateScrim(scrim.id, { slotlistMessageId: message.id });
}

/** Runs a background job without letting it crash the process. */
export function background(fn: () => Promise<unknown>, label: string): void {
  run(fn, label);
}

/** The cache the listeners use. */
export { scrimChannelCache };
