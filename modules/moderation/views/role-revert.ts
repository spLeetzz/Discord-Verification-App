/**
 * The role-revert button.
 *
 * After a moderator adds or removes a role, the success message carries a
 * button that puts it back.
 *
 * Quotient's version was a ternary:
 *
 * ```python
 * await _.remove_roles(self.role) if self.take_role else await _.add_roles(self.role)
 * ```
 *
 * Python parses that as `(await _.remove_roles(...)) if self.take_role
 * else (await _.add_roles(...))` — the `await` binds to each branch, not
 * to the whole conditional expression, because a conditional expression
 * binds looser than `await`. **The source's revert worked.**
 *
 * The port writes the same thing as an `if` over the action it recorded:
 * a role that was added is taken away again, and a role that was removed
 * is given back.
 *
 * The button is **public** (D43): the moderator who ran the command is
 * not the only person who may need to undo it, and an ephemeral message
 * with a button in it is a button nobody sees.
 *
 * The state lives in a token (D18): the role and the member list have no
 * database row, so the custom id carries a token that points into an
 * in-memory store.
 */

import { MessageFlags } from "discord.js";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  Guild,
  Role,
} from "discord.js";
import { makeCustomId, parseCustomId, TokenStore } from "../../../core/custom-id.js";
import { canManageRole, isStaff, STAFF_DENIAL_MESSAGE } from "../../../core/guards.js";
import { actionRow, secondaryButton, successButton } from "../../../core/ui.js";
import {
  outcomePanel,
  refusalPanel,
  replyPanel,
  replyPanelEphemeral,
} from "./panels.js";
import type { Panel } from "../../../core/ui.js";
import type { RoleAction, RoleApplyResult } from "../roles.js";

/** The prefix every custom id of this module carries. */
export const MODERATION_CUSTOM_ID_PREFIX = "moderation";

/** What a revert has to undo. */
export interface RoleRevertState {
  readonly guildId: string;
  readonly roleId: string;
  /** Everybody the action touched. */
  readonly memberIds: readonly string[];
  /** What the original action did. The revert does the opposite. */
  readonly action: RoleAction;
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
  action: RoleAction,
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

/**
 * The button row that carries the revert.
 *
 * The button undoes the change: "Take back" removes the role that was
 * just given, "Give back" puts back the role that was just taken. The
 * first is a plain undo and stays grey; the second gives something back
 * and is green. Neither is red — the button puts the server back the way
 * it was, it does not destroy a record.
 */
export function roleRevertButton(
  action: RoleAction,
  token: string,
): ActionRowBuilder<ButtonBuilder> {
  const customId = roleRevertCustomId(action, token);

  return actionRow(
    action === "add"
      ? secondaryButton({ customId, label: "Take back" })
      : successButton({ customId, label: "Give back" }),
  );
}

/**
 * The panel that carries the revert.
 *
 * It is the report of the change — what was done, to how many members,
 * and what went wrong — with the hint about the button in the footer, so
 * the description does not have to explain it.
 */
export function roleRevertPanel(
  action: RoleAction,
  role: Role,
  result: RoleApplyResult,
): Panel {
  const given = action === "add";

  return outcomePanel({
    kind: given ? "constructive" : "destructive",
    title: given ? "Role added" : "Role removed",
    description: given
      ? `${role.toString()} was given to ${result.changed} member${
          result.changed === 1 ? "" : "s"
        }.`
      : `${role.toString()} was taken from ${result.changed} member${
          result.changed === 1 ? "" : "s"
        }.`,
    fields: [
      { name: "Changed", value: String(result.changed), inline: true },
      ...(result.failed > 0
        ? [{ name: "Failed", value: String(result.failed), inline: true }]
        : []),
      ...(result.skipped > 0
        ? [{ name: "Skipped", value: String(result.skipped), inline: true }]
        : []),
    ],
    footer: "The button below undoes this. It works for one hour.",
  });
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
    await replyPanelEphemeral(
      interaction,
      refusalPanel("revert", STAFF_DENIAL_MESSAGE),
    );
    return true;
  }

  const state = revertStore.take(token);

  if (!state) {
    await replyPanelEphemeral(
      interaction,
      refusalPanel(
        "revert",
        "This button has expired. Please run the command again.",
      ),
    );
    return true;
  }

  const guild: Guild | null = interaction.guild;

  if (!guild || guild.id !== state.guildId) {
    await replyPanelEphemeral(
      interaction,
      refusalPanel("revert", "This button belongs to another server."),
    );
    return true;
  }

  const role = guild.roles.cache.get(state.roleId);

  if (!role) {
    await replyPanelEphemeral(
      interaction,
      refusalPanel(
        "revert",
        "That role no longer exists, so there is nothing to revert.",
      ),
    );
    return true;
  }

  // The hierarchy may have changed since the role was given out.
  const refusal = await canManageRole(interaction, role);

  if (refusal) {
    await replyPanelEphemeral(interaction, refusalPanel("revert", refusal));
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

  await replyPanel(
    interaction,
    outcomePanel({
      kind: state.action === "add" ? "destructive" : "constructive",
      title: "Reverted",
      description: `Reverted the role: ${verb} ${role.toString()} ${
        changed === 1 ? "from 1 member" : `from ${changed} members`
      }.`,
      fields:
        failed > 0
          ? [{ name: "Failed", value: String(failed), inline: true }]
          : [],
      footer: "The button was used, so it cannot be pressed again.",
    }),
  );

  return true;
}
