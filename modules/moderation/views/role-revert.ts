/**
 * The role-revert button.
 *
 * After a moderator adds or removes a role, the success message carries a
 * button that puts it back. Quotient's version was broken: the ternary
 *
 * ```python
 * await _.remove_roles(self.role) if self.take_role else await _.add_roles(self.role)
 * ```
 *
 * parses as `await (X if cond else Y)`, where `X` is already the resolved
 * result of a call rather than a coroutine — so the `await` raised
 * `TypeError: object list can't be used in 'await' expression` and the
 * revert never happened. The port parenthesises the branches, which is
 * the whole fix.
 *
 * The button is **public** (D43): the moderator who ran the command is
 * not the only person who may need to undo it, and an ephemeral message
 * with a button in it is a button nobody sees.
 *
 * The state lives in a token (D18): the role and the member list have no
 * database row, so the custom id carries a token that points into an
 * in-memory store.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import type { ButtonInteraction, Guild } from "discord.js";
import { makeCustomId, parseCustomId, TokenStore } from "../../../core/custom-id.js";
import { canManageRole, isStaff, STAFF_DENIAL_MESSAGE } from "../../../core/guards.js";

/** The prefix every custom id of this module carries. */
export const MODERATION_CUSTOM_ID_PREFIX = "moderation";

/** What a revert has to undo. */
export interface RoleRevertState {
  readonly guildId: string;
  readonly roleId: string;
  /** Everybody the action touched. */
  readonly memberIds: readonly string[];
  /** What the original action did. The revert does the opposite. */
  readonly action: "add" | "remove";
  /** The moderator who ran the command, for the audit-log reason. */
  readonly authorId: string;
  readonly authorLabel: string;
}

/** How long a revert button stays clickable. */
export const ROLE_REVERT_TTL_MS = 60 * 60_000;

const revertStore = new TokenStore<RoleRevertState>({ ttlMs: ROLE_REVERT_TTL_MS });

/**
 * The custom id of a revert button.
 *
 * `<area>:<action>[:<payload>]` — `moderation:role_revert:<action>:<token>`.
 * The action is in the id so that the id says what it does without
 * anybody having to look it up.
 */
export function roleRevertCustomId(
  action: "add" | "remove",
  token: string,
): string {
  return makeCustomId(
    MODERATION_CUSTOM_ID_PREFIX,
    "role_revert",
    `${action}:${token}`,
  );
}

/** Stores a revert and returns the token that points at it. */
export function issueRoleRevert(state: RoleRevertState): string {
  return revertStore.issue(state);
}

/** The button row that carries the revert. */
export function roleRevertButton(
  action: "add" | "remove",
  token: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(roleRevertCustomId(action, token))
      .setLabel(action === "add" ? "Take Back" : "Give Back")
      .setStyle(action === "add" ? ButtonStyle.Danger : ButtonStyle.Success),
  );
}

/**
 * Handles the revert button.
 *
 * @param interaction the button that was pressed.
 * @param payload     the part of the custom id after `moderation:role_revert`.
 *                    The router passes it; when it is not given, the custom
 *                    id is parsed.
 * @returns whether the interaction belonged to this handler.
 */
export async function handleRoleRevertButton(
  interaction: ButtonInteraction,
  payload?: string | null,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);

  if (!parsed || parsed.type !== MODERATION_CUSTOM_ID_PREFIX) return false;
  if (parsed.action !== "role_revert") return false;

  const raw = payload ?? parsed.payload;

  if (!raw) return false;

  // The payload is `<action>:<token>`. A payload with only a token is
  // accepted too, and the action is read from the store.
  const [actionPart, tokenPart] = raw.split(":");
  const token = tokenPart ?? actionPart ?? "";

  // The staff check comes first: a click by somebody who cannot use the
  // button must not consume it.
  if (!(await isStaff(interaction))) {
    await interaction.reply({
      content: STAFF_DENIAL_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const state = revertStore.take(token);

  if (!state) {
    await interaction.reply({
      content: "This button has expired. Please run the command again.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const guild: Guild | null = interaction.guild;

  if (!guild || guild.id !== state.guildId) {
    await interaction.reply({
      content: "This button belongs to another server.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const role = guild.roles.cache.get(state.roleId);

  if (!role) {
    await interaction.reply({
      content: "That role no longer exists, so there is nothing to revert.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // The hierarchy may have changed since the role was given out.
  const refusal = await canManageRole(interaction, role);

  if (refusal) {
    await interaction.reply({
      content: refusal,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = `Action done by ${state.authorLabel} (ID: ${state.authorId})`;

  let changed = 0;
  let failed = 0;

  for (const memberId of state.memberIds) {
    const member =
      guild.members.cache.get(memberId) ??
      (await guild.members.fetch(memberId).catch(() => null));

    if (!member) {
      failed += 1;
      continue;
    }

    try {
      // The revert does the opposite of what the original action did.
      if (state.action === "add") {
        await member.roles.remove(role, reason);
      } else {
        await member.roles.add(role, reason);
      }

      changed += 1;
    } catch {
      failed += 1;
    }
  }

  const verb = state.action === "add" ? "removed" : "given back";

  await interaction.editReply({
    content: `Reverted the role: ${verb} ${role.toString()} ${
      changed === 1 ? "from 1 member" : `from ${changed} members`
    }. (Failed: ${failed})`,
  });

  return true;
}
