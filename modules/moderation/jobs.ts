/**
 * The lockdown expiry.
 *
 * The scheduler picks the `jobs` row up when it is due, **deletes it** and
 * then dispatches it — which makes the whole thing idempotent: a job that
 * fires twice cannot unlock twice, because the second time there is no row
 * to fire.
 *
 * The expiry is a database row, not a `setTimeout`. A timer dies with the
 * process and the channel stays locked forever; a row does not.
 */

import type { Client, Guild } from "discord.js";
import { logger } from "../../utils/logger.js";
import { recordForPayload, releaseLock } from "./lockdown.js";
import type { LockContext } from "./lockdown.js";
import { parseLockdownJobPayload } from "./repo.js";
import type { LockPermission } from "./types.js";

/**
 * The permission a lockdown of this type changed.
 */
function permissionFor(type: string): LockPermission {
  switch (type) {
    case "maintenance":
    case "category":
      return "ViewChannel";
    default:
      return "SendMessages";
  }
}

/**
 * The module's job handler.
 *
 * The shape a job dispatcher wants: "here is the event and the payload —
 * do you handle it?"
 *
 * @returns whether the job belonged to this module.
 */
export async function handleModerationJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<boolean> {
  if (event !== "lockdown") return false;

  return handleLockdownJob(client, payload);
}

/**
 * Lifts a lockdown when its expiry comes due.
 *
 * @param payload the job's JSON payload.
 * @returns whether the job belonged to this module.
 */
export async function handleLockdownJob(
  client: Client,
  payload: unknown,
): Promise<boolean> {
  const parsed = parseLockdownJobPayload(payload);

  if (!parsed) return false;

  const guild =
    client.guilds.cache.get(parsed.guildId) ??
    (await client.guilds.fetch(parsed.guildId).catch(() => null));

  if (!guild) {
    logger.warn(
      `[Moderation] The guild ${parsed.guildId} is not available, so the lockdown cannot be lifted.`,
    );
    return true;
  }

  const record = await recordForPayload(parsed);

  // Somebody already lifted it by hand. Nothing to do.
  if (!record) return true;

  const botMember = guild.members.me;

  if (!botMember) {
    logger.warn(
      `[Moderation] I have no member record in ${guild.id}, so the lockdown cannot be lifted.`,
    );
    return true;
  }

  const context: LockContext = {
    guild,
    author: botMember,
    reason: "Lockdown timer complete!",
    sourceChannelId: parsed.sourceChannelId,
  };

  const target = parsed.roleId
    ? (guild.roles.cache.get(parsed.roleId) ?? guild.roles.everyone)
    : guild.roles.everyone;

  try {
    const result = await releaseLock({
      context,
      record,
      permission: permissionFor(parsed.type),
      target,
      restore: true,
    });

    logger.info(
      `[Moderation] Lockdown ${record.id} lifted: ${result.restored} channels restored, ${result.failed} failed.`,
    );

    await announceUnlock(guild, parsed.sourceChannelId, parsed.type);
  } catch (error) {
    logger.error(`[Moderation] Could not lift lockdown ${record.id}: ${String(error)}`);
  }

  return true;
}

/**
 * Says in the channel that the lockdown is over.
 *
 * The message is public on purpose: the moderator who set the timer may
 * not be around, and the people who were waiting for the channel to open
 * should see that it did.
 */
async function announceUnlock(
  guild: Guild,
  sourceChannelId: string | null,
  type: string,
): Promise<void> {
  if (!sourceChannelId) return;

  const channel = guild.channels.cache.get(sourceChannelId);

  if (!channel || !channel.isTextBased()) return;

  const message =
    type === "guild"
      ? "Unlocked the server."
      : type === "maintenance"
        ? "Maintenance mode is over."
        : "Unlocked the channel.";

  try {
    await channel.send(message);
  } catch {
    // The channel may be gone. The unlock still happened.
  }
}
