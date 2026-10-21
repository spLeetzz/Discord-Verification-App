/**
 * The ignore role.
 *
 * Quotient created a guild role called `quotient-tag-ignore` so a member
 * could opt out of the tag check and the easy tag, and it looked that role
 * up **by name on every single message**:
 *
 * ```python
 * @property
 * def ignorerole(self):
 *     return discord.utils.get(self._guild.roles, name="quotient-tag-ignore")
 * ```
 *
 * The port stores the role's **id** on the configuration row (D16) and
 * looks the member's roles up by id. The name is only ever used to
 * **create** the role, which happens once.
 */

import type { Guild } from "discord.js";
import { TAG_IGNORE_ROLE_NAME } from "./types.js";

/**
 * The roles this process has already resolved, per guild.
 *
 * A fallback for the case where the configuration rows cannot hold the id
 * yet (see the note in `repo.ts`). It is a cache, not a lookup: the name
 * is resolved once per guild per process, never per message.
 */
const resolved = new Map<string, string>();

/**
 * Finds the guild's ignore role, or creates it.
 *
 * @returns the role's id.
 */
export async function ensureIgnoreRole(guild: Guild): Promise<string> {
  const known = resolved.get(guild.id);

  if (known) return known;

  const existing = guild.roles.cache.find(
    (role) => role.name === TAG_IGNORE_ROLE_NAME,
  );

  if (existing) {
    resolved.set(guild.id, existing.id);

    return existing.id;
  }

  const created = await guild.roles.create({
    name: TAG_IGNORE_ROLE_NAME,
    reason: "Lets a member opt out of the tag checks",
  });

  resolved.set(guild.id, created.id);

  return created.id;
}

/**
 * The ignore role's id, when this process knows it.
 */
export function knownIgnoreRoleId(guildId: string): string | null {
  return resolved.get(guildId) ?? null;
}

/**
 * Remembers an ignore role's id.
 *
 * Used when the id was read out of a configuration row.
 */
export function rememberIgnoreRole(guildId: string, roleId: string): void {
  resolved.set(guildId, roleId);
}

/**
 * Forgets everything.
 *
 * For the tests.
 */
export function forgetIgnoreRoles(): void {
  resolved.clear();
}

/**
 * Does the member hold the ignore role?
 *
 * The role is compared **by id** (D16). A role that merely carries the
 * name `quotient-tag-ignore` does not opt anybody out — the id is what
 * counts, and the id is what the configuration row holds.
 *
 * @param roleIds     the ids of the roles the member holds.
 * @param ignoreRoleId the id of the ignore role, or `null` when the guild
 *                     has none.
 */
export function isIgnoredMember(
  roleIds: readonly string[],
  ignoreRoleId: string | null,
): boolean {
  if (!ignoreRoleId) return false;

  return roleIds.includes(ignoreRoleId);
}
