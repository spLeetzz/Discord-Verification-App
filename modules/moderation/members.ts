/**
 * Kicking, banning and unbanning.
 *
 * Quotient's `MemberID` converter returned a fake object when the member
 * was not in the guild — the hackban case — and that object quacked like a
 * member. Here the two cases are separate branches of a union
 * (`MemberTarget`), so a caller cannot read `.roles` off a bare id.
 *
 * The hierarchy is checked for **both** the moderator and the bot, in
 * that order, exactly as Quotient's converter did.
 */

import type { Guild, GuildMember } from "discord.js";
import { PermissionDeniedError } from "../../core/errors.js";
import { checkActorHierarchy, checkBotHierarchy } from "./hierarchy.js";
import type { MemberTarget } from "./types.js";

/**
 * Reads a user id out of a mention or a bare snowflake.
 *
 * @returns the id, or `null` when the text is not one.
 */
export function parseUserId(input: string): string | null {
  const trimmed = input.trim();

  const mention = /^<@!?(\d{15,25})>$/.exec(trimmed);
  if (mention) return mention[1] ?? null;

  if (/^\d{15,25}$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Resolves an id to a member, or to an id on its own.
 *
 * An id that is not in the guild is the hackban case: the member may
 * have left, or may never have been in the guild.
 */
export async function resolveMemberTarget(
  guild: Guild,
  id: string,
): Promise<MemberTarget> {
  const member =
    guild.members.cache.get(id) ??
    (await guild.members.fetch(id).catch(() => null));

  if (member) return { kind: "member", id: member.id, member };

  return { kind: "id", id };
}

/**
 * Checks that the moderator and the bot are both above the target.
 *
 * A target that is not in the guild has no roles to compare, so the
 * hierarchy check does not apply — the same as Quotient, which returned
 * the fake member before it ever reached the comparison. The permission
 * checks in the command still apply.
 *
 * @returns the refusal message, or `null` when the action may go ahead.
 */
export function checkTargetHierarchy(
  guild: Guild,
  author: GuildMember,
  target: MemberTarget,
): string | null {
  if (target.kind !== "member") return null;

  const targetSubject = {
    id: target.id,
    topRolePosition: target.member.roles.highest.position,
  };

  const actorRefusal = checkActorHierarchy({
    actor: {
      id: author.id,
      topRolePosition: author.roles.highest.position,
    },
    target: targetSubject,
    isGuildOwner: author.id === guild.ownerId,
    isBotOwner: false,
  });

  if (actorRefusal) return actorRefusal;

  const botMember = guild.members.me;

  if (botMember) {
    const botRefusal = checkBotHierarchy(
      {
        id: botMember.id,
        topRolePosition: botMember.roles.highest.position,
      },
      targetSubject,
    );

    if (botRefusal) return botRefusal;
  }

  return null;
}

/**
 * How the target is named in a message.
 *
 * Quotient's fake member printed `"Member ID 12345"`, which is the honest
 * description of an id that is not in the guild.
 */
export function describeTarget(target: MemberTarget): string {
  if (target.kind === "member") return target.member.user.tag;

  return `Member ID ${target.id}`;
}

/** Kicks a member, or a bare id. */
export async function kickTarget(
  guild: Guild,
  target: MemberTarget,
  reason: string,
): Promise<void> {
  if (target.kind === "member") {
    await target.member.kick(reason);
    return;
  }

  await guild.members.kick(target.id, reason);
}

/** Bans a member, or a bare id. */
export async function banTarget(
  guild: Guild,
  target: MemberTarget,
  reason: string,
): Promise<void> {
  await guild.members.ban(target.id, { reason });
}

/** What an unban found. */
export interface UnbanResult {
  /** The reason the member was banned for, when the ban recorded one. */
  readonly previousReason: string | null;
}

/**
 * Unbans a member.
 *
 * The previous reason is read before the ban is lifted, because Discord
 * drops it afterwards.
 */
export async function unbanTarget(
  guild: Guild,
  userId: string,
  reason: string,
): Promise<UnbanResult> {
  let previousReason: string | null = null;

  try {
    const ban = await guild.bans.fetch(userId);
    previousReason = ban.reason ?? null;
  } catch {
    // The member was not banned, or the ban could not be read. The unban
    // itself will say so.
  }

  await guild.members.unban(userId, reason);

  return { previousReason };
}

/**
 * Throws when the hierarchy refuses the action.
 */
export function assertTargetHierarchy(
  guild: Guild,
  author: GuildMember,
  target: MemberTarget,
): void {
  const refusal = checkTargetHierarchy(guild, author, target);

  if (refusal) throw new PermissionDeniedError(refusal);
}
