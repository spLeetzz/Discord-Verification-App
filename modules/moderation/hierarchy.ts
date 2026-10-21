/**
 * The role hierarchy, for actions aimed at a *member*.
 *
 * Quotient's `MemberID` converter checked two things before it let a
 * moderation action through:
 *
 * ```python
 * if not can_execute_action(ctx, ctx.author, m):   # the moderator
 * elif not can_execute_action(ctx, ctx.me, m):      # the bot
 * ```
 *
 * and `can_execute_action` was "you are the bot's owner, or you are the
 * guild's owner, or your top role is above the target's top role".
 *
 * The role-hierarchy guard in `core/guards.ts` (`canManageRole`) is the
 * *role* version of the same idea and is used as-is for the role commands.
 * This file is the member version, which `core/guards.ts` does not have.
 * It is deliberately the same shape — a pure decision, no Discord calls —
 * so it can be tested on its own.
 */

/** A participant in a hierarchy comparison. */
export interface HierarchySubject {
  readonly id: string;
  /** The position of the subject's highest role. */
  readonly topRolePosition: number;
}

/**
 * Is the actor strictly above the target?
 *
 * Strictly: two members with the same top role cannot act on each other,
 * which is the same rule Discord itself uses.
 */
export function outranks(
  actor: HierarchySubject,
  target: HierarchySubject,
): boolean {
  return actor.topRolePosition > target.topRolePosition;
}

/** The refusal when the moderator is not above the target. */
export const ACTOR_HIERARCHY_REFUSAL =
  "You cannot do this action on this user due to role hierarchy.";

/** The refusal when the bot is not above the target. */
export const BOT_HIERARCHY_REFUSAL =
  "I cannot do this action on this user due to role hierarchy.";

/** What a hierarchy check needs to know. */
export interface HierarchyOptions {
  /** The moderator. */
  readonly actor: HierarchySubject;
  /** The member the action is aimed at. */
  readonly target: HierarchySubject;
  /** Is the moderator the owner of the guild? */
  readonly isGuildOwner: boolean;
  /** Is the moderator the owner of the bot? */
  readonly isBotOwner: boolean;
}

/**
 * May the moderator act on the target?
 *
 * The bot's owner and the guild's owner may act on anybody, exactly as in
 * Quotient.
 *
 * @returns the refusal message, or `null` when the action may go ahead.
 */
export function checkActorHierarchy(
  options: HierarchyOptions,
): string | null {
  if (options.isBotOwner || options.isGuildOwner) return null;
  if (outranks(options.actor, options.target)) return null;

  return ACTOR_HIERARCHY_REFUSAL;
}

/**
 * May the bot act on the target?
 *
 * The bot is never the owner of anything, so there is no exemption here —
 * the same as Quotient, where `ctx.me` failed both owner checks and the
 * comparison was purely positional.
 *
 * @returns the refusal message, or `null` when the action may go ahead.
 */
export function checkBotHierarchy(
  bot: HierarchySubject,
  target: HierarchySubject,
): string | null {
  if (outranks(bot, target)) return null;

  return BOT_HIERARCHY_REFUSAL;
}
