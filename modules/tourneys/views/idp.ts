/**
 * The ID-Pass view — a custom room's credentials, and the button that
 * hands them over in a copyable block.
 *
 * Quotient's `idp` command posted an embed with a room's id, password and
 * map, and a "Get in Copy Format" button. The message deleted itself
 * after thirty minutes, so the password did not linger in the channel.
 *
 * **The credentials live in the message, and nowhere else.** The button
 * reads them back out of the message it is attached to, so the copy
 * survives a restart — a view that held them in memory would show an
 * empty block after one, and the command would be useless while the bot
 * was down. The message is public for half an hour (that is the source's
 * behaviour) and the deletion is a durable job row, never a timer.
 *
 * **The message and the copy block are the *same* text**: the embed's
 * description is the copy block, so the two can never disagree.
 */

import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
} from "discord.js";
import { respond } from "../../../core/context.js";
import { actionRow, panelEmbed, primaryButton } from "../../../core/ui.js";
import { fail } from "./handlers.js";
import { tourneysId } from "./ids.js";

/** The credentials of a custom room. */
export interface RoomCredentials {
  /** The room id the teams type in. */
  readonly roomId: string;
  /** The room's password. */
  readonly password: string;
  /** The map the room is set to. */
  readonly map: string;
}

/**
 * The label of the button that hands the credentials over.
 *
 * Short, verb-first and unpunctuated: the button copies the details.
 */
export const IDP_COPY_LABEL = "Copy details";

/** How long the message lives before it deletes itself, in minutes. */
export const IDP_LIFETIME_MINUTES = 30;

/** How long the message lives before it deletes itself, in milliseconds. */
export const IDP_LIFETIME_MS = IDP_LIFETIME_MINUTES * 60_000;

/**
 * The longest run of backticks in a text.
 *
 * A fenced block is closed by a run of backticks, so a password that
 * contains them would end the block early and spill the rest of the
 * values out of it.
 */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;

  for (const character of text) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }

    current = 0;
  }

  return longest;
}

/**
 * The copy block: the three values, in one fenced block.
 *
 * A fenced block is what this area already uses for a copyable list (see
 * `groups.ts`'s `renderGroupList`), and Discord gives a code block a
 * "Copy" button — which is the whole point of the button.
 *
 * The fence is longer than any run of backticks in the values, so a
 * password that contains backticks cannot break out of the block.
 */
export function formatIdpCopy(credentials: RoomCredentials): string {
  const body = [
    `Room ID: ${credentials.roomId}`,
    `Password: ${credentials.password}`,
    `Map: ${credentials.map}`,
  ].join("\n");

  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));

  return [fence, body, fence].join("\n");
}

/**
 * The embed the message carries.
 *
 * The description **is** the copy block, so the button has exactly one
 * thing to read back.
 */
export function buildIdpEmbed(credentials: RoomCredentials) {
  return panelEmbed({
    title: "Custom room — ID pass",
    description: formatIdpCopy(credentials),
    footer: `Press ${IDP_COPY_LABEL} to get a copyable block. This message deletes itself in ${IDP_LIFETIME_MINUTES} minutes.`,
  });
}

/**
 * The button row of the message.
 */
export function buildIdpComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    actionRow(
      primaryButton({
        customId: tourneysId("idp_copy"),
        label: IDP_COPY_LABEL,
      }),
    ),
  ];
}

/**
 * The "Copy details" button.
 *
 * The credentials are read back out of the message the button is on, so
 * the copy works after a restart — nothing is held in memory between the
 * command and the click.
 *
 * The reply is **ephemeral**: the copy is for the member who pressed the
 * button, and the message it came from is public already.
 */
export async function handleIdpCopy(
  interaction: ButtonInteraction,
): Promise<void> {
  const description = interaction.message.embeds[0]?.description;

  if (!description) {
    await fail(interaction, "The room details are no longer available.");

    return;
  }

  await respond(interaction, { content: description }, true);
}
