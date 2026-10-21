/**
 * Giving and taking roles.
 *
 * Quotient's `role` group took a greedy list of members, which does not
 * exist in discord.js. The port takes a string of mentions and parses it,
 * plus an explicit `apply_to_all` flag — the flag exists because the
 * "everybody" path is a *confirm* in the source, and a confirm needs a
 * deliberate choice rather than an empty argument list.
 */

import type { Guild, GuildMember, Role } from "discord.js";
import { PermissionDeniedError } from "../../core/errors.js";
import { canManageRole } from "../../core/guards.js";

/** Which members a bulk role action covers. */
export type RoleScope = "all" | "humans" | "bots";

/** What a role action does. */
export type RoleAction = "add" | "remove";

/**
 * Pulls the ids out of a list of mentions.
 *
 * Accepts `<@123>` and `<@!123>` as well as bare snowflakes, because a
 * moderator pasting from the member list gets one of the two.
 */
export function parseMentionIds(input: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const add = (id: string | undefined): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const mentions = /<@!?(\d{15,25})>/g;
  let match: RegExpExecArray | null = mentions.exec(input);

  while (match !== null) {
    add(match[1]);
    match = mentions.exec(input);
  }

  const bare = /(?:^|\s)(\d{15,25})(?=\s|$)/g;
  match = bare.exec(input);

  while (match !== null) {
    add(match[1]);
    match = bare.exec(input);
  }

  return ids;
}

/**
 * The members a bulk role action covers.
 *
 * The rules are Quotient's: `humans` skips bots, `bots` keeps only bots,
 * and a member who already has the role is skipped when the role is being
 * given and a member who does not have it is skipped when it is being
 * taken.
 */
export function selectMembersForRole(
  guild: Guild,
  role: Role,
  scope: RoleScope,
  action: RoleAction,
): GuildMember[] {
  const members = [...guild.members.cache.values()];

  return members.filter((member) => {
    if (scope === "humans" && member.user.bot) return false;
    if (scope === "bots" && !member.user.bot) return false;

    const hasRole = member.roles.cache.has(role.id);

    return action === "add" ? !hasRole : hasRole;
  });
}

/** What a role action did. */
export interface RoleApplyResult {
  /** How many members the role was actually given to or taken from. */
  readonly changed: number;
  /** How many members could not be reached or changed. */
  readonly failed: number;
  /** How many members were skipped because they were already in the
   *  wanted state. */
  readonly skipped: number;
  /** The members the action touched, for the revert. */
  readonly memberIds: string[];
}

/** A request to give or take a role. */
export interface RoleApplyRequest {
  readonly guild: Guild;
  readonly role: Role;
  /** The members to act on. Empty for a bulk action. */
  readonly memberIds: readonly string[];
  readonly action: RoleAction;
  /** The audit-log reason. */
  readonly reason: string;
}

/**
 * Gives the role to the members, or takes it away.
 *
 * The members are looked up in the guild cache first: a bulk action over
 * a thousand members must not be a thousand API calls.
 */
export async function applyRoleToMembers(
  request: RoleApplyRequest,
): Promise<RoleApplyResult> {
  const { guild, role, action, reason } = request;

  let changed = 0;
  let failed = 0;
  let skipped = 0;
  const memberIds: string[] = [];

  for (const memberId of request.memberIds) {
    const member =
      guild.members.cache.get(memberId) ??
      (await guild.members.fetch(memberId).catch(() => null));

    if (!member) {
      failed += 1;
      continue;
    }

    const hasRole = member.roles.cache.has(role.id);

    if (action === "add" && hasRole) {
      skipped += 1;
      continue;
    }

    if (action === "remove" && !hasRole) {
      skipped += 1;
      continue;
    }

    try {
      if (action === "add") {
        await member.roles.add(role, reason);
      } else {
        await member.roles.remove(role, reason);
      }

      changed += 1;
      memberIds.push(member.id);
    } catch {
      failed += 1;
    }
  }

  return { changed, failed, skipped, memberIds };
}

/**
 * Checks that the moderator may manage the role.
 *
 * The five rules live in `core/guards.ts` (`canManageRole`) and are used
 * as they are — this is only the wrapper that turns the refusal into an
 * error the command adapter can render.
 */
export async function assertCanManageRole(
  interaction: Parameters<typeof canManageRole>[0],
  role: Role,
): Promise<void> {
  const refusal = await canManageRole(interaction, role);

  if (refusal) throw new PermissionDeniedError(refusal);
}
