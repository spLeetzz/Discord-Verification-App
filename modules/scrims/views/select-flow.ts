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
  RoleSelectMenuBuilder,
} from "discord.js";
import type { RepliableInteraction } from "discord.js";
import { randomId } from "../../../core/custom-id.js";
import { respond } from "../../../core/context.js";

/** How long the menu stays open. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Opens a channel menu and waits for a channel.
 *
 * @returns the channel id, or `null` when nobody chose anything.
 */
export async function awaitChannelSelect(
  interaction: RepliableInteraction,
  options: { placeholder?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const customId = randomId();

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(options.placeholder ?? "Pick a channel")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const handle = await respond(
    interaction,
    {
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu),
      ],
    },
    true,
  );

  try {
    const answer = await handle.awaitMessageComponent({
      componentType: ComponentType.ChannelSelect,
      time: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      filter: (candidate) =>
        candidate.customId === customId &&
        candidate.user.id === interaction.user.id,
    });

    const value = answer.isChannelSelectMenu() ? answer.values[0] : undefined;

    await answer.update({ components: [] });

    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens a role menu and waits for a role.
 *
 * @returns the role id, or `null` when nobody chose anything.
 */
export async function awaitRoleSelect(
  interaction: RepliableInteraction,
  options: { placeholder?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const customId = randomId();

  const menu = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(options.placeholder ?? "Pick a role");

  const handle = await respond(
    interaction,
    {
      components: [
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu),
      ],
    },
    true,
  );

  try {
    const answer = await handle.awaitMessageComponent({
      componentType: ComponentType.RoleSelect,
      time: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      filter: (candidate) =>
        candidate.customId === customId &&
        candidate.user.id === interaction.user.id,
    });

    const value = answer.isRoleSelectMenu() ? answer.values[0] : undefined;

    await answer.update({ components: [] });

    return value ?? null;
  } catch {
    return null;
  }
}
