/**
 * The listeners of the tournaments area.
 *
 * Three things listen:
 *
 *  1. a **message** in a registration channel — the registration intake;
 *  2. a **message** in a media-partner channel — the cross-guild path;
 *  3. a **reaction** in a registration channel — the reaction-based
 *    registration path and its cancel.
 *
 * The source's flow (`src/cogs/esports/events/tourneys.py:102-133`):
 *
 * ```python
 * if channel_id not in self.bot.cache.tourney_channels: return
 * tourney = await Tourney.get_or_none(registration_channel_id=channel_id)
 * if tourney is None: return self.bot.cache.tourney_channels.discard(channel_id)
 * if tourney.started_at is None: return
 * if tourney.is_ignorable(message.author): return
 * if not before_registrations(message, tourney.role): return ...
 * message.content = normalize("NFKC", message.content.lower())
 * if not await check_tourney_requirements(self.bot, message, tourney): return
 * async with self.__tourney_lock:
 *     await self.__process_tourney_message(message, tourney)
 * ```
 *
 * Three things are deliberately different:
 *
 *  - **The lock is gone.** The source protected the registration with a
 *    module-global `asyncio.Lock` that died with the process. Ours takes
 *    the slot number from a per-tourney sequence inside a transaction
 *    (D25), so the database enforces it.
 *  - **The message is never mutated.** The source lower-cased
 *    `message.content` in place. We normalise a copy (D27).
 *  - **The status is checked explicitly.** The source inferred "open"
 *    from `started_at` being non-null, which could not tell a paused
 *    tournament from a closed one (D26).
 */

import type {
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
} from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { run } from "../../core/fire-and-forget.js";
import { findTeam, TEAM_NAME_MAX_LENGTH } from "../../core/team-name.js";
import { truncate } from "../../core/text.js";
import { logger } from "../../utils/logger.js";
import { mediaPartnerChannelCache, tourneyChannelCache } from "./channel-cache.js";
import { evaluateRegistration } from "./requirements.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import type { TourneyRecord } from "./types.js";
import {
  giveSuccessRole,
  removeSuccessRole,
  sendSuccessMessage,
  strikeConfirmMessage,
} from "./views/lifecycle.js";
import { isForeignPartnerChannel } from "./views/partner.js";

/**
 * The reply the source showed for each refusal.
 *
 * The wording is Quotient's, so the users who know the old bot still
 * recognise it.
 */
const DENIAL_MESSAGES: Record<string, string> = {
  botmention: "Don't mention bots. Mention your real teammates.",
  /**
   * The tournament is open but nobody can register in it, because the
   * success role has not been set. The refusal used to be silent, so a
   * member who typed in the registration channel got nothing at all.
   */
  notready:
    "This tournament is not ready for registrations yet — the success role has not been set. A moderator has to set it in the tournament's settings.",
  nomention: "You did not mention enough teammates.",
  banned: "You are banned from the tournaments. You cannot register.",
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

  /**
   * **Every way out of here is logged.**
   *
   * A registration that is not taken used to be a silent return, so a
   * member who typed in the registration channel got no reply and no
   * clue why. There are six ways out of this function and each one is a
   * different reason, so the log says which one it was.
   */
  const skip = (reason: string): false => {
    logger.info(
      `[Tourneys] A message in ${channelId} was not a registration: ${reason}.`,
    );

    return false;
  };

  if (!tourneyChannelCache.has(channelId)) {
    return skip("the channel is not a registration channel of any tournament");
  }

  const tourney = await repo.getTourneyByRegistrationChannel(channelId);

  if (!tourney) {
    // The tournament was deleted. The cache is stale.
    tourneyChannelCache.remove(channelId);

    return skip("the cached tournament no longer exists");
  }

  if (tourney.status !== "open") {
    return skip(`the tournament ${tourney.id} is ${tourney.status}, not open`);
  }

  /**
   * **A tournament with no success role cannot register anybody.**
   *
   * There is nothing to give a member when they register, so the
   * intake refused every message in the registration channel — and it
   * refused them *silently*, so a member who typed there got no reply
   * and no clue that the bot was even listening. It is answered now,
   * through the same refusal the other refusals use.
   */
  if (!tourney.roleId) {
    await refuseRegistration(message, tourney, "notready");

    return false;
  }

  const member = message.guild.members.cache.get(message.author.id);

  if (member && (await isTourneyMod(member))) {
    return skip("the author is a tournament moderator");
  }

  if (!canRegister(message, tourney)) {
    logger.warn(
      `[Tourneys] Cannot accept registrations for the tournament ${tourney.id}: the bot lacks a permission in ${channelId}.`,
    );

    return true;
  }

  const facts = messageFacts(message);

  const context = await service.buildRegistrationContext(tourney, facts);

  const reason = await evaluateRegistration(context);

  if (reason) {
    await refuseRegistration(message, tourney, reason);

    return true;
  }

  const slot = await service.registerTeam(tourney, {
    teamName: truncate(context.teamName, TEAM_NAME_MAX_LENGTH),
    leaderId: message.author.id,
    members: memberIds(message),
    messageId: message.id,
    jumpUrl: message.url,
  });

  if (!slot) {
    await refuseRegistration(message, tourney, "nomention");

    return true;
  }

  await acceptRegistration(message, tourney, slot.id);

  return true;
}

/**
 * Handles a message in a **media-partner** channel.
 *
 * **This is the one path that crosses a guild boundary.** The bot is a
 * member of both guilds; it receives the message in the partner's
 * channel and decides whether to accept it into this guild's tournament.
 *
 * The source's checks:
 *
 *  1. the partner tournament must still exist;
 *  2. the author must have registered in the partner tournament;
 *  3. the same requirements matrix as the normal path.
 */
export async function handleMediaPartnerMessage(message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guild) return false;

  const channelId = message.channelId;

  if (!mediaPartnerChannelCache.has(channelId)) return false;

  const partner = await repo.getMediaPartnerByChannel(channelId);

  if (!partner) {
    mediaPartnerChannelCache.remove(channelId);

    return false;
  }

  const tourney = await repo.getTourney(partner.tourneyId);

  if (!tourney) {
    mediaPartnerChannelCache.remove(channelId);

    return false;
  }

  // The cross-guild check, made explicit.
  if (!isForeignPartnerChannel(tourney.guildId, message.guild.id)) {
    logger.warn(
      `[Tourneys] The media-partner channel ${channelId} is in the same guild as the tournament ${tourney.id}. Ignoring it.`,
    );

    return false;
  }

  if (tourney.status !== "open") return false;
  if (!tourney.roleId) return false;

  const member = message.guild.members.cache.get(message.author.id);

  if (member && (await isTourneyMod(member))) return false;

  // The partner tournament: the one in the partner guild whose
  // registration channel is this channel.
  const partnerTourney = await repo.getTourneyByRegistrationChannel(channelId);

  if (!partnerTourney) {
    await message
      .reply(
        "You cannot register because the partner tournament was deleted. Kindly register directly through the tournament's own registration channel.",
      )
      .catch(() => undefined);

    return true;
  }

  const leaderIds = await repo.listLeaderIds(partnerTourney.id);

  if (!leaderIds.includes(message.author.id)) {
    await message
      .reply(
        "You cannot register through here because you did not register in the media-partner tournament. Kindly register through the tournament's own registration channel.",
      )
      .catch(() => undefined);

    return true;
  }

  const facts = messageFacts(message);

  const context = await service.buildRegistrationContext(tourney, facts);

  const reason = await evaluateRegistration(context);

  if (reason) {
    await refuseRegistration(message, tourney, reason);

    return true;
  }

  const slot = await service.registerTeam(tourney, {
    teamName: truncate(context.teamName, TEAM_NAME_MAX_LENGTH),
    leaderId: message.author.id,
    members: memberIds(message),
    messageId: message.id,
    jumpUrl: message.url,
  });

  if (!slot) {
    await refuseRegistration(message, tourney, "nomention");

    return true;
  }

  await repo.insertMediaPartnerSlot({
    mediaPartnerId: partner.id,
    userId: message.author.id,
    messageId: message.id,
    jumpUrl: message.url,
    members: memberIds(message),
  });

  await acceptRegistration(message, tourney, slot.id);

  return true;
}

/* ------------------------------------------------------------------ *
 * The reaction path
 * ------------------------------------------------------------------ */

/**
 * Handles a reaction in a registration channel.
 *
 * **The source's reaction path skipped the requirements matrix
 * entirely and never checked whether the tournament was open.** Both are
 * fixed here: the same guards run, and a tournament that is not `open`
 * accepts no registrations (D26).
 *
 * The source's cross-reaction cancel was a literal `await ...` on the
 * `Ellipsis` object:
 *
 * ```python
 * if str(payload.emoji) == tourney.cross_emoji:
 *     return await ...  # cancel kardo slot user ka
 * ```
 *
 * which raises `TypeError` — **the feature had never worked**. The
 * stated intent is implemented here: the reacting user's slot for that
 * message is deleted, the confirmation message is struck through, and
 * the success role is removed when it was their only slot.
 */
export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: { readonly id: string },
): Promise<boolean> {
  const message = await resolveMessage(reaction.message);

  if (!message) return false;
  if (message.author.bot) return false;

  const guild = message.guild;

  if (!guild) return false;

  const channelId = message.channelId;

  if (!tourneyChannelCache.has(channelId)) return false;

  const tourney = await repo.getTourneyByRegistrationChannel(channelId);

  if (!tourney) {
    tourneyChannelCache.remove(channelId);

    return false;
  }

  const emoji = reaction.emoji.name ?? "";

  const isTick = emoji === tourney.emojis.tick;
  const isCross = emoji === tourney.emojis.cross;

  if (!isTick && !isCross) return false;

  if (isCross) {
    await cancelByReaction(message, tourney, user);

    return true;
  }

  // The tick path registers the **author of the message**, which is what
  // the source did. The source let only a tournament moderator trigger
  // it — it was a "moderator approves this registration" affordance —
  // and that check is kept, because otherwise a stranger could register
  // somebody else by reacting to their message.
  const member = guild.members.cache.get(user.id);

  if (!member || !(await isTourneyMod(member))) return false;

  // **The tournament has to be open.** The source did not check this: it
  // only refused a tournament that had been *closed*, so a tournament
  // that had never opened accepted registrations.
  if (tourney.status !== "open") return false;
  if (!tourney.roleId) return false;

  const existing = await repo.getSlotByMessage(tourney.id, message.id);

  if (existing) return true;

  const facts = messageFacts(message);

  const context = await service.buildRegistrationContext(tourney, facts);

  // **The requirements matrix runs here too.** The source skipped it
  // completely on this path.
  const reason = await evaluateRegistration(context);

  if (reason) {
    await refuseRegistration(message, tourney, reason);

    return true;
  }

  const slot = await service.registerTeam(tourney, {
    teamName: truncate(context.teamName, TEAM_NAME_MAX_LENGTH),
    leaderId: message.author.id,
    members: memberIds(message),
    messageId: message.id,
    jumpUrl: message.url,
  });

  if (!slot) {
    await refuseRegistration(message, tourney, "nomention");

    return true;
  }

  await acceptRegistration(message, tourney, slot.id);

  return true;
}

/**
 * Cancels the reacting user's slot for a message.
 *
 * The stated intent of the source's `await ...`:
 *
 *  1. delete the reacting user's slot for that message;
 *  2. strike the confirmation message through;
 *  3. remove the success role when it was their only slot.
 */
async function cancelByReaction(
  message: Message,
  tourney: TourneyRecord,
  user: { readonly id: string },
): Promise<void> {
  const slots = await repo.listSlotsOfUser(tourney.id, user.id);

  const slot = slots.find((entry) => entry.messageId === message.id);

  if (!slot) return;

  await service.removeSlot(tourney.id, slot.id);

  const guild = message.guild;

  if (!guild) return;

  await strikeConfirmMessage(guild, slot.confirmJumpUrl);

  if (!(await service.hasOtherSlot(tourney.id, user.id, slot.id))) {
    await removeSuccessRole(guild, tourney, user.id);
  }
}

/* ------------------------------------------------------------------ *
 * A deleted registration message
 * ------------------------------------------------------------------ */

/**
 * Handles the deletion of a registration message.
 *
 * The source deleted the slot, struck the confirmation message through
 * and removed the success role when it was the last one. Ours does the
 * same.
 */
export async function handleMessageDelete(
  message: Message | PartialMessage,
): Promise<boolean> {
  const guild = message.guild;

  if (!guild) return false;

  const channelId = message.channelId;

  // Only a registration channel can hold a slot. The check keeps the
  // listener from asking the database about every deleted message in
  // every server the bot is in.
  if (!tourneyChannelCache.has(channelId)) return false;

  const tourney = await repo.getTourneyByRegistrationChannel(channelId);

  if (!tourney) return false;

  const slot = await repo.getSlotByMessage(tourney.id, message.id);

  if (!slot) return false;

  await service.removeSlot(tourney.id, slot.id);

  await strikeConfirmMessage(guild, slot.confirmJumpUrl);

  if (!(await service.hasOtherSlot(tourney.id, slot.leaderId, slot.id))) {
    await removeSuccessRole(guild, tourney, slot.leaderId);
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Is this a full message rather than a partial one?
 *
 * A partial message has no author; a full one always does.
 */
function isFullMessage(
  message: Message | PartialMessage,
): message is Message {
  return message.author !== null;
}

/**
 * Resolves a message that may be partial.
 *
 * A reaction on a message the bot has not cached arrives as a partial
 * one, and a partial message has no content and no mentions — so it has
 * to be fetched before it can be read.
 */
async function resolveMessage(
  raw: Message | PartialMessage,
): Promise<Message | null> {
  if (isFullMessage(raw)) return raw;

  return raw.fetch().catch(() => null);
}

/** The facts the requirements matrix reads, from a message. */
function messageFacts(message: Message) {
  return {
    content: message.content,
    authorId: message.author.id,
    mentions: [...message.mentions.users.values()].map((user) => ({
      id: user.id,
      isBot: user.bot,
    })),
  };
}

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
 * May the bot accept a registration in this channel?
 *
 * The source's `before_registrations`: the success role must exist, the
 * bot must be able to manage roles, the role must be below the bot's
 * top role, and the bot must be able to add reactions and use external
 * emojis in the channel.
 */
export function canRegister(
  message: Message,
  tourney: { roleId: string },
): boolean {
  if (!tourney.roleId) return false;

  const guild = message.guild;

  if (!guild) return false;

  const me = guild.members.me;

  if (!me) return false;

  const role = guild.roles.cache.get(tourney.roleId);

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

/**
 * Is this member a tournament moderator?
 *
 * The source's `Tourney.is_ignorable` was a substring match on the role
 * names. The role-name half is kept — there is nowhere in the schema to
 * store a per-guild tourney-mod role id — and it is *additive*.
 */
export async function isTourneyMod(member: {
  roles: { cache: { some(predicate: (role: { name: string }) => boolean): boolean } };
  permissions: { has(permission: bigint): boolean };
}): Promise<boolean> {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  return member.roles.cache.some(
    (role) => role.name.trim().toLowerCase() === "tourney-mod",
  );
}

/** Adds the tick and gives the role. */
async function acceptRegistration(
  message: Message,
  tourney: TourneyRecord,
  slotId: string,
): Promise<void> {
  await message.react(tourney.emojis.tick).catch(() => undefined);

  const guild = message.guild;

  if (guild) {
    await giveSuccessRole(guild, tourney, message.author.id);
  }

  const slot = await repo.getSlot(slotId);

  if (slot) {
    await sendSuccessMessage(
      tourney,
      message.author.id,
      slot.jumpUrl,
      message.client,
    );
  }

  // The last slot was taken: the tournament closes itself.
  const count = await repo.countSlots(tourney.id);

  if (count < tourney.totalSlots) return;

  run(
    async () => {
      const fresh = await repo.getTourney(tourney.id);

      if (!fresh || fresh.status !== "open") return;

      await service.closeTourney(tourney.id).catch(() => undefined);
    },
    "tourneys.closeWhenFull",
  );
}

/** Refuses a registration and says why. */
async function refuseRegistration(
  message: Message,
  tourney: TourneyRecord,
  reason: string,
): Promise<void> {
  await message.react(tourney.emojis.cross).catch(() => undefined);

  const text = DENIAL_MESSAGES[reason] ?? "Your registration was refused.";

  await message.reply({ content: text }).catch(() => undefined);

  if (tourney.autodeleteRejects) {
    run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      await message.delete().catch(() => undefined);
    }, "tourneys.deleteRejected");
  }
}

/** The team name a message produces, for the views that show it. */
export function teamNameOf(message: Message): string {
  return truncate(
    findTeam({
      content: message.content,
      author: { toString: () => `<@${message.author.id}>` },
    }),
    TEAM_NAME_MAX_LENGTH,
  );
}
