/**
 * Opening and closing registration — the Discord half.
 *
 * The state transitions live in `service.ts`; this file does the
 * Discord work around them: the messages, the channel permissions and
 * the slotlist.
 *
 * The source's `should_open_scrim` checked five things before it opened
 * a scrim, and wrote the reason to the log channel. The same five
 * checks are made here.
 */

import type { ButtonInteraction, Guild, TextBasedChannel } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { MessageFlags } from "discord.js";
import { run } from "../../../core/fire-and-forget.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import {
  renderCloseMessage,
  renderOpenMessage,
  slotListLines,
} from "../render.js";
import type { ScrimRecord } from "../types.js";
import { buildScrimPanel } from "./manager.js";
import { publishSlotlist } from "./slotlist.js";
import { fail } from "./handlers.js";

/**
 * May the scrim open?
 *
 * @returns the reason it may not, or `null` when it may.
 */
export function checkCanOpen(
  guild: Guild,
  scrim: ScrimRecord,
): string | null {
  const channel = guild.channels.cache.get(scrim.registrationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    return "I couldn't find the registration channel. Maybe it is deleted, or hidden from me.";
  }

  const me = guild.members.me;

  if (!me) return "I could not find my own member record.";

  const permissions = channel.permissionsFor(me);

  if (!permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return `I do not have \`Manage Channels\` in ${channel.toString()}.`;
  }

  if (!scrim.roleId) {
    return "I couldn't find the success role.";
  }

  const role = guild.roles.cache.get(scrim.roleId);

  if (!role) return "I couldn't find the success role.";

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "I don't have `Manage Roles` in this server.";
  }

  if (role.position >= me.roles.highest.position) {
    return `The success role (${role.toString()}) is above my top role (${me.roles.highest.toString()}).`;
  }

  if (scrim.openRoleId && !guild.roles.cache.get(scrim.openRoleId)) {
    return "You have set an open role earlier and I couldn't find it.";
  }

  return null;
}

/** The channel a scrim registers in. */
function registrationChannel(
  guild: Guild,
  scrim: ScrimRecord,
): TextBasedChannel | null {
  const channel = guild.channels.cache.get(scrim.registrationChannelId);

  if (!channel) return null;

  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return null;
  }

  return channel as TextBasedChannel;
}

/**
 * Opens or closes the registration channel for the open role.
 *
 * The source toggled the `send_messages` permission of the open role.
 * Ours does the same: a closed scrim's channel is read-only for
 * everybody except the staff role.
 */
async function toggleChannel(
  guild: Guild,
  scrim: ScrimRecord,
  open: boolean,
): Promise<boolean> {
  const channel = guild.channels.cache.get(scrim.registrationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) return false;

  const roleId = scrim.openRoleId;

  if (!roleId) return false;

  const role = guild.roles.cache.get(roleId);

  if (!role) return false;

  try {
    await channel.permissionOverwrites.edit(
      role,
      { SendMessages: open },
      {
        reason: open
          ? "Scrim registration is open."
          : "Scrim registration is over.",
      },
    );

    return true;
  } catch {
    return false;
  }
}

/** Opens a scrim's registration. */
export async function openRegistrationFlow(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const refusal = checkCanOpen(guild, scrim);

  if (refusal) {
    await fail(interaction, refusal);

    return;
  }

  await interaction.deferUpdate().catch(() => undefined);

  let result: service.OpenResult;

  try {
    result = await service.openRegistration(scrim.id);
  } catch (error) {
    await fail(
      interaction,
      error instanceof Error ? error.message : "The scrim could not be opened.",
    );

    return;
  }

  const fresh = result.scrim;
  const channel = registrationChannel(guild, fresh);

  const reserved = await repo.listReservedSlots(fresh.id);
  const banned = await repo.listBans(fresh.id);

  const embed = renderOpenMessage(fresh, {
    mentions: fresh.requiredMentions,
    totalSlots: fresh.totalSlots,
    reservedCount: reserved.length,
    slotlistMention: `<#${fresh.slotlistChannelId}>`,
    multiregister: fresh.multiregister,
    teamnameCompulsion: fresh.teamnameCompulsion,
    bannedMentions: banned.map((ban) => `<@${ban.userId}>`).join(", "),
    reservedMentions: reserved
      .filter((slot) => slot.userId)
      .map((slot) => `<@${slot.userId}>`)
      .join(", "),
  });

  if (channel) {
    const pingRole = fresh.pingRoleId
      ? guild.roles.cache.get(fresh.pingRoleId)
      : null;

    await channel
      .send({
        content: pingRole ? pingRole.toString() : undefined,
        embeds: [embed],
        allowedMentions: { roles: [fresh.pingRoleId ?? ""] },
      })
      .catch(() => undefined);
  }

  await toggleChannel(guild, fresh, true);

  const panel = buildScrimPanel(fresh);

  await interaction.message?.edit({
    embeds: panel.embeds,
    components: panel.components,
  });
}

/** Closes a scrim's registration. */
export async function closeRegistrationFlow(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
): Promise<void> {
  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  await interaction.deferUpdate().catch(() => undefined);

  let result: service.CloseResult;

  try {
    result = await service.closeRegistration(scrim.id);
  } catch (error) {
    await fail(
      interaction,
      error instanceof Error ? error.message : "The scrim could not be closed.",
    );

    return;
  }

  const fresh = result.scrim;
  const channel = registrationChannel(guild, fresh);

  const embed = renderCloseMessage(fresh, {
    totalSlots: fresh.totalSlots,
    filled: result.filled,
    elapsedSeconds: result.elapsedSeconds,
    openTime: fresh.openTime,
  });

  if (channel) {
    await channel.send({ embeds: [embed] }).catch(() => undefined);
  }

  await toggleChannel(guild, fresh, false);

  if (fresh.autoslotlist && result.registered.length > 0) {
    const slotlistChannel = guild.channels.cache.get(fresh.slotlistChannelId);

    if (slotlistChannel && "send" in slotlistChannel) {
      run(
        async () => {
          const message = await publishSlotlist(
            slotlistChannel as never,
            fresh,
            result.registered,
          );

          await repo.updateScrim(fresh.id, { slotlistMessageId: message.id });
        },
        "scrims.publishSlotlist",
      );
    }
  }

  const panel = buildScrimPanel(fresh);

  await interaction.message?.edit({
    embeds: panel.embeds,
    components: panel.components,
  });
}

/** The text of a scrim's slotlist, as the source printed it in the log. */
export function textSlotlist(
  scrim: ScrimRecord,
  slots: readonly { num: number; teamName: string | null; ownerUserId: string | null }[],
): string {
  let text = `${scrim.name} Slot details:\n\n`;

  for (const slot of slots) {
    text += `${slot.num}. ${slot.teamName ?? "—"} ${
      slot.ownerUserId ? `<@${slot.ownerUserId}>` : ""
    }\n`;
  }

  return text;
}

/** The slot lines of a slotlist, for the embed. */
export { slotListLines };

/** The flags of an ephemeral follow-up. */
export const EPHEMERAL = MessageFlags.Ephemeral;
