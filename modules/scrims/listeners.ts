/**
 * The registration intake — the `MessageCreate` listener.
 *
 * A message in a registration channel is checked against the
 * requirements matrix, and a registration that passes it takes a slot.
 *
 * The source's flow (`src/cogs/esports/events/scrims.py:34-106`):
 *
 * ```python
 * if channel_id not in self.bot.cache.scrim_channels: return
 * scrim = await Scrim.get_or_none(registration_channel_id=channel_id)
 * if scrim.opened_at is None or scrim.role is None: return
 * if Scrim.is_ignorable(message.author): return
 * if not before_registrations(message, scrim_role): return ...
 * message.content = normalize("NFKC", message.content.lower())
 * if not await check_scrim_requirements(self.bot, message, scrim): return
 * async with self.__scrim_lock:
 *     ...claim a slot...
 * ```
 *
 * Two things are deliberately different:
 *
 *  - **The lock is gone.** The source protected the claim with a
 *    module-global `asyncio.Lock` that died with the process, so two
 *    users could own one slot. Ours is a single conditional `UPDATE`
 *    (D14), and the database enforces the invariant.
 *  - **The message is never mutated.** The source lower-cased
 *    `message.content` in place. We normalise a copy (D27).
 */

import type { Message } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { run } from "../../core/fire-and-forget.js";
import { logger } from "../../utils/logger.js";
import { evaluateRegistration } from "./requirements.js";
import { scrimChannelCache } from "./channel-cache.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { truncate } from "../../core/text.js";
import { TEAM_NAME_MAX_LENGTH } from "../../core/team-name.js";

/** The member ids a registration mentions, bots excluded. */
function memberIds(message: Message): string[] {
  const ids = new Set<string>([message.author.id]);

  for (const user of message.mentions.users.values()) {
    if (user.bot) continue;

    ids.add(user.id);
  }

  return [...ids];
}

/**
 * The reply the source showed for each refusal.
 *
 * The wording is Quotient's, so the users who know the old bot still
 * recognise it.
 */
const DENIAL_MESSAGES: Record<string, string> = {
  botmention: "Don't mention bots. Mention your real teammates.",
  nomention: "You did not mention enough teammates.",
  banned: "You are banned from the scrims. You cannot register.",
  multiregister:
    "This server does not allow multiple registrations. You have already registered once.",
  noteamname: "A team name is required to register.",
  duplicate: "Someone has already registered with the same team name.",
  nolines:
    "Your registration message is too short. It seems you missed some required information.",
  faketag: "Someone has already registered with the same mentions.",
};

/**
 * Handles a message in a registration channel.
 *
 * @returns `true` when the message was a registration attempt, whether
 *          it was accepted or refused.
 */
export async function handleRegistrationMessage(
  message: Message,
): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guild) return false;

  const channelId = message.channelId;

  if (!scrimChannelCache.has(channelId)) return false;

  const scrim = await repo.getScrimByRegistrationChannel(channelId);

  if (!scrim) {
    // The scrim was deleted. The cache is stale.
    scrimChannelCache.remove(channelId);

    return false;
  }

  if (scrim.status !== "open") return false;
  if (!scrim.roleId) return false;

  const member = message.guild.members.cache.get(message.author.id);

  if (member && (await isScrimMod(member))) return false;

  if (!canRegister(message, scrim)) {
    await reportCannotRegister(message, scrim);

    return true;
  }

  const context = await service.buildRegistrationContext(scrim, {
    content: message.content,
    authorId: message.author.id,
    mentions: [...message.mentions.users.values()].map((user) => ({
      id: user.id,
      isBot: user.bot,
    })),
  });

  const reason = await evaluateRegistration(context);

  if (reason) {
    await refuseRegistration(message, scrim, reason);

    return true;
  }

  const claimed = await service.claimSlotForRegistration(scrim, {
    teamName: truncate(context.teamName, TEAM_NAME_MAX_LENGTH),
    ownerUserId: message.author.id,
    members: memberIds(message),
    messageId: message.id,
    jumpUrl: message.url,
  });

  if (!claimed) {
    await refuseRegistration(message, scrim, "nomention");

    return true;
  }

  await acceptRegistration(message, scrim, claimed.id);

  return true;
}

/**
 * May the bot accept a registration in this channel?
 *
 * The source's `before_registrations`: the success role must exist, the
 * bot must be able to manage roles, the role must be below the bot's
 * top role, and the bot must be able to add reactions and use external
 * emojis in the channel.
 */
export function canRegister(message: Message, scrim: { roleId: string | null }): boolean {
  if (!scrim.roleId) return false;

  const guild = message.guild;

  if (!guild) return false;

  const me = guild.members.me;

  if (!me) return false;

  const role = guild.roles.cache.get(scrim.roleId);

  if (!role) return false;

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;

  if (role.position >= me.roles.highest.position) return false;

  if (message.channel.type !== ChannelType.GuildText) return true;

  const permissions = message.channel.permissionsFor(me);

  if (!permissions) return true;

  return (
    permissions.has(PermissionFlagsBits.AddReactions) &&
    permissions.has(PermissionFlagsBits.UseExternalEmojis)
  );
}

/** Is this member a scrim moderator? */
export function isScrimMod(member: {
  roles: { cache: { some(predicate: (role: { name: string }) => boolean): boolean } };
  permissions: { has(permission: PermissionFlagsBits): boolean };
}): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  return member.roles.cache.some(
    (role) => role.name.trim().toLowerCase() === "scrims-mod",
  );
}

/** Adds the tick and gives the role. */
async function acceptRegistration(
  message: Message,
  scrim: { id: string; roleId: string | null; emojis: { tick: string } },
  slotId: string,
): Promise<void> {
  const guild = message.guild;

  if (!guild) return;

  await message.react(scrim.emojis.tick).catch(() => undefined);

  if (scrim.roleId) {
    const member = await guild.members.fetch(message.author.id).catch(() => null);

    if (member) {
      const role = guild.roles.cache.get(scrim.roleId);

      if (role) {
        await member.roles.add(role).catch(() => undefined);
      }
    }
  }

  // The last slot was taken: the scrim closes itself.
  const free = await repo.countFreeSlots(scrim.id);

  if (free === 0) {
    run(async () => {
      const fresh = await repo.getScrim(scrim.id);

      if (!fresh || fresh.status !== "open") return;

      await service.closeRegistration(scrim.id);
    }, "scrims.closeWhenFull");

    return;
  }

  void slotId;
}

/** Refuses a registration and says why. */
async function refuseRegistration(
  message: Message,
  scrim: { emojis: { cross: string }; autodeleteRejects: boolean },
  reason: string,
): Promise<void> {
  await message.react(scrim.emojis.cross).catch(() => undefined);

  const text = DENIAL_MESSAGES[reason] ?? "Your registration was refused.";

  await message.reply({ content: text }).catch(() => undefined);

  if (scrim.autodeleteRejects) {
    run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      await message.delete().catch(() => undefined);
    }, "scrims.deleteRejected");
  }
}

/** Tells the moderators that the bot cannot accept registrations. */
async function reportCannotRegister(
  message: Message,
  scrim: { id: string },
): Promise<void> {
  logger.warn(
    `[Scrims] Cannot accept registrations for scrim ${scrim.id}: the bot lacks a permission in ${message.channelId}.`,
  );
}
