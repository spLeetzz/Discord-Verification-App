/**
 * The published slot list's public API.
 *
 * **One panel, one owner.** The slot area owns the slot-list panel: the
 * buttons, their custom ids (`slots:slotlist_*`) and the edit, punish
 * and info operations behind them. The scrims area owns the scrim
 * lifecycle: open, close, the daily `scrim_open` job, the autoclean —
 * and, with it, the moment a scrim closes with `autoslotlist` on and
 * its slot list has to be published.
 *
 * Those two facts meet here. The scrims area does not build a slot list
 * of its own; it calls {@link publishSlotList} to publish one and
 * {@link refreshSlotListMessage} to re-render one, and
 * {@link buildSlotListPanel} when it renders the panel itself. The
 * result is that there is exactly one implementation of what a published
 * slot list looks like, and one namespace for its buttons.
 *
 * The import direction is one-way — the scrims area calls the slot
 * area, never the other way round — so this creates no cycle.
 *
 * The two rules this module owns:
 *
 *  - **`scrims.slotlist_message_id` is written here.** The publisher
 *    records the message it sent, and nobody else writes the column. The
 *    scrims area must not write it.
 *  - **The `scrim_ban` job payload is `{ scrimIds, userIds }`.** That is
 *    the shape the scrims area's `scrim_ban` handler reads, and it is
 *    the shape `repo.scheduleBanExpiry` writes.
 */

import { ChannelType } from "discord.js";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  TextChannel,
} from "discord.js";
import { logger } from "../../utils/logger.js";
import { slotsClient } from "./client.js";
import * as repo from "./repo.js";
import type { SlotRecord } from "./types.js";
import {
  buildSlotListEmbed,
  buildSlotListRows,
  findSlotListMessage,
  renderSlotListMessage,
  sendSlotListMessage,
} from "./views/slotlist.js";

/**
 * Publishes a scrim's slot list and returns the message id, or null when
 * there is nothing to publish.
 *
 * The message goes into the scrim's slotlist channel, or into
 * `channelId` when the caller names one. It carries the slot area's
 * Edit / Punish / Info panel.
 *
 * **Nothing to publish** is one of three things, and all three answer
 * `null` rather than throwing:
 *
 *  - the scrim does not exist;
 *  - the channel cannot be found;
 *  - **no team has claimed a slot.** A slot list with no teams in it is
 *    not a slot list, and publishing one would leave a message in a
 *    channel that says nothing.
 *
 * The message id is written to `scrims.slotlist_message_id`, so the
 * message is found again after a restart without anybody rediscovering
 * it by name. **This module is the only writer of that column.**
 *
 * Publishing is idempotent: when the scrim already has a published slot
 * list, that message is re-rendered in place instead of a second one
 * being sent. A second message would be an orphan — the row would
 * remember only one of the two — and the panel would fight over the
 * same list.
 *
 * @param scrimId   the scrim whose slot list is published;
 * @param channelId the channel to publish into. Defaults to the
 *                  scrim's own slotlist channel.
 * @returns the id of the message, or `null` when there was nothing to
 *          publish.
 */
export async function publishSlotList(
  scrimId: string,
  channelId?: string,
): Promise<string | null> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim) return null;

  const slots = await repo.listSlots(scrim.id);

  if (!hasClaimedSlot(slots)) return null;

  const client = slotsClient();

  if (!client) {
    logger.warn(
      "[Slots] Cannot publish a slot list: the area has no client yet.",
    );

    return null;
  }

  // The scrim may already have a published slot list. It is re-rendered
  // in place rather than sent twice.
  if (scrim.slotlistMessageId) {
    const refreshed = await refreshSlotList(scrim.slotlistMessageId);

    if (refreshed) return scrim.slotlistMessageId;
  }

  const channel = await resolveChannel(
    client,
    channelId ?? scrim.slotlistChannelId,
  );

  if (!channel) return null;

  const messageId = await sendSlotListMessage(channel, scrim, slots);

  await repo.setScrimSlotlistMessage(scrim.id, messageId);

  return messageId;
}

/**
 * Re-renders an already-published slot list message.
 *
 * The message is found by its id: the scrim row that holds the id also
 * holds the channel and everything the body needs, so a restart does
 * not lose the list.
 *
 * A message that cannot be found — deleted, or the bot lost the
 * permission — is left alone. The call answers either way; it is a
 * refresh, not a repair.
 */
export async function refreshSlotListMessage(
  messageId: string,
): Promise<void> {
  await refreshSlotList(messageId);
}

/**
 * The panel rows for a scrim's slot list, for an area that renders the
 * message itself.
 *
 * The rows are the slot area's: `slots:slotlist_edit`,
 * `slots:slotlist_punish` and `slots:slotlist_info`, each carrying the
 * scrim id, so the panel keeps working after a restart (D18). The
 * buttons are answered by the slot area, whatever area rendered them.
 */
export function buildSlotListPanel(
  scrimId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return buildSlotListRows(scrimId);
}

/**
 * The body of a published slot list.
 *
 * Exported so that an area which renders the list itself shows the same
 * body the published message shows.
 */
export { buildSlotListEmbed };

/* ------------------------------------------------------------------ *
 * The internals
 * ------------------------------------------------------------------ */

/**
 * Is there a team in this scrim?
 *
 * A slot list with no teams in it says nothing, so there is nothing to
 * publish.
 */
function hasClaimedSlot(slots: readonly SlotRecord[]): boolean {
  return slots.some((slot) => slot.state === "claimed");
}

/**
 * Re-renders a published slot list message.
 *
 * @returns whether the message was found and re-rendered.
 */
async function refreshSlotList(messageId: string): Promise<boolean> {
  const scrim = await repo.getScrimBySlotlistMessageId(messageId);

  if (!scrim) return false;

  const client = slotsClient();

  if (!client) {
    logger.warn(
      "[Slots] Cannot refresh a slot list: the area has no client yet.",
    );

    return false;
  }

  const message = await findSlotListMessage(client, scrim, messageId);

  if (!message) return false;

  const slots = await repo.listSlots(scrim.id);

  await renderSlotListMessage(message, scrim, slots);

  return true;
}

/**
 * The channel a slot list is published into.
 *
 * The cache first, because a channel that is cached costs nothing; the
 * API second, because a channel that is not cached still has to work.
 */
async function resolveChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | null> {
  const cached = client.channels.cache.get(channelId);

  if (cached && cached.type === ChannelType.GuildText) return cached;

  const fetched = await client.channels.fetch(channelId).catch(() => null);

  if (!fetched || fetched.type !== ChannelType.GuildText) return null;

  return fetched;
}
