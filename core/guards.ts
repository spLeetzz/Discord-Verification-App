/**
 * Guards — the one place authorisation is decided.
 *
 * D28: a guard is a predicate that answers "may this caller do this?".
 * It returns `null` to allow and a string to refuse, and the refusal string
 * is what the user is shown. Guards never throw past the dispatcher.
 *
 * Everything here is a pure decision: no database, no network beyond the
 * guild cache. The premium lookup is *injected* (D15), which is what keeps
 * `core/` free of `db/` imports and makes every guard testable without a
 * running Postgres.
 *
 * The dispatcher runs guards in the order `guildOnly → staffOnly → guards`,
 * before `execute`.
 */

import { PermissionFlagsBits } from "discord.js";
import type {
  GuildTextBasedChannel,
  Interaction,
  PermissionResolvable,
  Role,
} from "discord.js";
import { getGuildMember } from "../utils/member.js";
import type { EntitlementLookup, PremiumFeature } from "./premium.js";

/**
 * A guard.
 *
 * @returns `null` when the action is allowed, or the refusal message when
 *          it is not.
 */
export type Guard = (interaction: Interaction) => Promise<string | null>;

/**
 * The name of the staff role.
 *
 * Role names are not stable identifiers, but the staff role has always been
 * called "Moderator" in this guild, and the existing verification flow is
 * frozen with that check (D16).
 */
export const STAFF_ROLE_NAME = "Moderator";

/** The refusal the shipped staff check shows. */
export const STAFF_DENIAL_MESSAGE =
  "You do not have permission to use this command. Only members with the **Moderator** role can use staff commands.";

/**
 * The refusal Quotient showed when somebody other than the person who
 * started a flow pressed one of its buttons.
 *
 * Kept verbatim — it is the wording users of the old bot already know.
 */
export const OWNER_DENIAL_MESSAGE =
  "Sorry, you can't use this interaction as it is not started by you.";

/**
 * Is the caller staff?
 *
 * Administrator, or a member of the role named "Moderator".
 *
 * This is the check the existing verification flow uses. Its behaviour is
 * frozen: do not "improve" it into a permission check.
 */
export async function isStaff(interaction: Interaction): Promise<boolean> {
  const member = await getGuildMember(interaction);
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  return member.roles.cache.some((role) => role.name === STAFF_ROLE_NAME);
}

/**
 * Is the caller an administrator?
 */
export async function isAdmin(interaction: Interaction): Promise<boolean> {
  const member = await getGuildMember(interaction);
  if (!member) return false;

  return member.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * Does the caller hold these permissions in the guild?
 */
export async function hasGuildPermissions(
  interaction: Interaction,
  permissions: PermissionResolvable,
): Promise<boolean> {
  const member = await getGuildMember(interaction);
  if (!member) return false;

  return member.permissions.has(permissions);
}

/**
 * Does the caller hold these permissions in a channel?
 *
 * @param channel the channel to check. Defaults to the channel the
 *                interaction came from.
 */
export async function hasChannelPermissions(
  interaction: Interaction,
  permissions: PermissionResolvable,
  channel?: GuildTextBasedChannel | null,
): Promise<boolean> {
  const member = await getGuildMember(interaction);
  if (!member) return false;

  const target = channel ?? interaction.channel;

  if (!target || target.isDMBased()) return false;

  return target.permissionsFor(member).has(permissions);
}

/**
 * May the caller manage this role?
 *
 * Quotient's `role_command_check` (`src/core/decorators.py:65-93`) has
 * exactly five rules, and they are checked in this order:
 *
 *  1. the role is managed by an integration;
 *  2. the role is at or above the bot's top role;
 *  3. the role is at or above the caller's top role (the guild owner is
 *     exempt);
 *  4. the role carries more permissions than the caller;
 *  5. the role has the administrator permission.
 *
 * The wording of each refusal is Quotient's.
 *
 * @returns the refusal message, or `null` when the role may be managed.
 */
export async function canManageRole(
  interaction: Interaction,
  role: Role,
): Promise<string | null> {
  const guild = interaction.guild;

  if (!guild) {
    return "This can only be used in a server.";
  }

  // 1. Managed roles belong to an integration (bot role, Nitro booster).
  if (role.managed) {
    return "Role is an integrated role and cannot be added manually.";
  }

  const author = await getGuildMember(interaction);

  if (!author) {
    return "I could not work out who you are. Please try again in a moment.";
  }

  const botMember = guild.members.me;

  if (!botMember) {
    return `I could not find my own member record, so I cannot check ${role.toString()}.`;
  }

  const botTopRole = botMember.roles.highest;

  // 2. The role is above the bot.
  if (botTopRole.position <= role.position) {
    return `The position of ${role.toString()} is above my toprole (${botTopRole.toString()})`;
  }

  const authorTopRole = author.roles.highest;

  // 3. The role is above the caller. The guild owner may manage anything
  //    they can see.
  if (author.id !== guild.ownerId && authorTopRole.position <= role.position) {
    return `The position of ${role.toString()} is above your top role (${authorTopRole.toString()})`;
  }

  // 4. The role is more powerful than the caller.
  if (role.permissions.bitfield > author.permissions.bitfield) {
    return `${role.toString()} has higher permissions than you.`;
  }

  // 5. The role has administrator.
  if (role.permissions.has(PermissionFlagsBits.Administrator)) {
    return `${role.toString()} has administrator permissions.`;
  }

  return null;
}

/**
 * Only the person who started this may use it.
 *
 * @param ownerId the id of the member who started the flow.
 */
export function ownerGuard(ownerId: string): Guard {
  return async (interaction) =>
    interaction.user.id === ownerId ? null : OWNER_DENIAL_MESSAGE;
}

/**
 * The caller has to be staff.
 */
export function staffGuard(): Guard {
  return async (interaction) =>
    (await isStaff(interaction)) ? null : STAFF_DENIAL_MESSAGE;
}

/**
 * The caller has to be an administrator.
 */
export function adminGuard(): Guard {
  return async (interaction) =>
    (await isAdmin(interaction)) ? null : STAFF_DENIAL_MESSAGE;
}

/**
 * The guild has to hold an entitlement (D15).
 *
 * @param feature       the entitlement the feature needs.
 * @param entitlements  the lookup. Injected so `core/` never imports `db/`.
 * @param message       the refusal to show. Defaults to a message that
 *                      names the feature.
 */
export function premiumGuard(
  feature: PremiumFeature,
  entitlements: EntitlementLookup,
  message?: string,
): Guard {
  return async (interaction) => {
    const guildId = interaction.guildId;

    if (!guildId) {
      return "This command only works in a server.";
    }

    if (await entitlements.isEntitled(guildId, feature)) return null;

    return (
      message ??
      `This feature needs a premium entitlement for **${feature}**. Please upgrade to unlock it.`
    );
  };
}

/** How a count limit is checked. */
export interface CountLimitOptions {
  /** The maximum the guild may have. */
  limit: number;
  /** What the thing is called in the message, e.g. `"scrims"`. */
  label: string;
  /** How many the guild already has. Injected, for the same reason as the
   *  entitlement lookup. */
  count: (guildId: string) => Promise<number>;
  /**
   * The entitlement that lifts the limit.
   *
   * When the guild holds it, the limit does not apply — that is how the
   * free tier and the paid tier differ.
   */
  entitlements?: EntitlementLookup;
  /** The feature whose entitlement lifts the limit. */
  feature?: PremiumFeature;
}

/**
 * The guild may not create one more of something.
 *
 * The limit comes from the free-tier allowance table (D45) — the canonical
 * one lives in `modules/premium/limits.ts` — so the number in the code and
 * the number in the perk list cannot drift apart. It is passed in rather
 * than read here, so no allowance is hard-coded in the runtime layer.
 */
export function countLimitGuard(options: CountLimitOptions): Guard {
  const { limit, label, count, entitlements, feature } = options;

  return async (interaction) => {
    const guildId = interaction.guildId;

    if (!guildId) {
      return "This command only works in a server.";
    }

    if (entitlements && feature) {
      if (await entitlements.isEntitled(guildId, feature)) return null;
    }

    const current = await count(guildId);

    if (current < limit) return null;

    return `You can only have ${limit} ${label} on this server. You already have ${current}.`;
  };
}

/**
 * Runs several guards in order and returns the first refusal.
 *
 * The order matters: the dispatcher runs `guildOnly → staffOnly → guards`,
 * and a list of guards inside that slot keeps the same property — the
 * cheapest, most general check refuses first.
 */
export function combineGuards(...guards: readonly Guard[]): Guard {
  return async (interaction) => {
    for (const guard of guards) {
      const refusal = await guard(interaction);

      if (refusal) return refusal;
    }

    return null;
  };
}

/**
 * The guard factories, gathered in one place.
 *
 * D28 calls for `Guards.maxScrims(3)` to be expressible; the generic
 * {@link countLimitGuard} is what every area should use, with the number
 * read from the free-tier table rather than hard-coded.
 */
export const Guards = {
  staff: staffGuard,
  admin: adminGuard,
  owner: ownerGuard,
  premium: premiumGuard,
  maxCount: countLimitGuard,
  all: combineGuards,
} as const;
