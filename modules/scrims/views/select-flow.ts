/**
 * Waiting for a channel or a role to be picked.
 *
 * D17: "Channel or role → a select menu. No text parsing, no
 * `wait_for`." A channel select and a role select are message
 * components, not modal inputs, so the menu is shown in an ephemeral
 * message and the answer is collected from it.
 *
 * The menu carries a random custom id, so two menus open in the same
 * channel at the same time cannot be answered by the same click, and
 * the collector only accepts the member who opened it.
 */

import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  MessageFlags,
  RoleSelectMenuBuilder,
} from "discord.js";
import type { Interaction, MessageComponentInteraction } from "discord.js";
import { randomId } from "../../../core/custom-id.js";

/** How long the menu stays open. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Opens a channel menu and waits for a channel.
 *
 * @returns the channel id, or `null` when nobody chose anything.
 */
export async function awaitChannelSelect(
  interaction: Interaction,
  options: { placeholder?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const customId = randomId();

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(options.placeholder ?? "Pick a channel")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  await interaction.reply({
    components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu),
    ],
    flags: MessageFlags.Ephemeral,
  });

  const answer = await collect(
    interaction,
    ComponentType.ChannelSelect,
    customId,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!answer) return null;

  return answer.values[0] ?? null;
}

/**
 * Opens a role menu and waits for a role.
 *
 * @returns the role id, or `null` when nobody chose anything.
 */
export async function awaitRoleSelect(
  interaction: Interaction,
  options: { placeholder?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const customId = randomId();

  const menu = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(options.placeholder ?? "Pick a role");

  await interaction.reply({
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu),
    ],
    flags: MessageFlags.Ephemeral,
  });

  const answer = await collect(
    interaction,
    ComponentType.RoleSelect,
    customId,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!answer) return null;

  return answer.values[0] ?? null;
}

/** Collects the answer, or `null` when the menu timed out. */
async function collect(
  interaction: Interaction,
  componentType: ComponentType.ChannelSelect | ComponentType.RoleSelect,
  customId: string,
  timeoutMs: number,
): Promise<MessageComponentInteraction | null> {
  try {
    const answer = await interaction.awaitMessageComponent({
      componentType,
      time: timeoutMs,
      filter: (candidate) =>
        candidate.customId === customId &&
        candidate.user.id === interaction.user.id,
    });

    await answer.update({ components: [] }).catch(() => undefined);

    return answer;
  } catch {
    return null;
  }
}
