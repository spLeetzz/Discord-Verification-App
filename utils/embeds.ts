import { basename } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import type { ParticipantResult } from "../types/sheet.js";
import type { TicketSubmission } from "../types/ticket.js";
import type { UserLike } from "../types/user.js";

export function buildVerificationEmbed(eventKey: EventKey): EmbedBuilder {
  const cfg = EVENTS[eventKey];
  const embed = new EmbedBuilder()
    .setTitle(cfg.displayName)
    .setDescription(cfg.description)
    .setColor(0x229db7);

  // The logo is optional — the Free Fire embed ships without one because the
  // shared CDN link carries an expiry token that eventually 404s.
  if (cfg.imageUrl) {
    embed.setImage(cfg.imageUrl);
  }

  return embed;
}

export function buildVerificationButtonRow(
  eventKey: EventKey,
): ActionRowBuilder<ButtonBuilder> {
  const btn = new ButtonBuilder()
    .setCustomId(`verify_btn:${eventKey}`)
    .setLabel("Start Verification")
    .setEmoji("📩")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn);
}

export function buildVerificationModal(eventKey: EventKey): ModalBuilder {
  const cfg = EVENTS[eventKey];
  const modal = new ModalBuilder()
    .setCustomId(`verify_modal:${eventKey}`)
    .setTitle("Event Verification");

  const labels = cfg.modalFields.map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(field.placeholder)
      .setRequired(field.required);

    return new LabelBuilder()
      .setLabel(field.label)
      .setTextInputComponent(input);
  });

  modal.addLabelComponents(...labels);

  return modal;
}

interface Player {
  name: string;
  dob: string;
}

/**
 * BGMI rows hold the captain in fixed columns, then up to four teammates
 * six columns apart. The sheet layout is fixed, so the offsets are literal.
 */
function parseBGMIPlayers(row: string[]): Player[] {
  const players: Player[] = [];

  const captain = row[4];
  if (captain) players.push({ name: captain, dob: row[6] ?? "" });

  for (const start of [11, 17, 23, 29]) {
    const name = row[start];
    if (!name) break;
    players.push({ name, dob: row[start + 2] ?? "" });
  }

  return players;
}

export function buildPinnedContent(
  user: UserLike,
  eventKey: EventKey,
  submission: TicketSubmission,
  result: ParticipantResult,
): string {
  const cfg = EVENTS[eventKey];
  const tag = `${user}`; // resolves to a <@id> mention

  // Direct-registration events have no sheet row to show — the pinned
  // message echoes what the participant typed.
  if (cfg.mode === "direct-registration") {
    return [
      "📋 **REG Details**",
      `**Team Name:** ${submission.name}`,
      `**Email:** ${submission.email}`,
      `**Phone:** ${submission.phone ?? "N/A"}`,
      `**Discord:** ${tag}`,
      "",
      "**Status:** ⏳ Pending staff verification",
    ].join("\n");
  }

  const row = result.rows[0];

  if (result.status === "not_found" || !row) {
    const lines = [
      "📋 **REG Details**",
      `**Email:** ${submission.email}`,
      `**Discord:** ${tag}`,
    ];

    if (eventKey === "Chess" && submission.chessRating) {
      lines.push(`**Chess.com Rating:** ${submission.chessRating}`);
    }

    lines.push("**Status:** ❌ Not found in current sheet");

    return lines.join("\n");
  }

  if (cfg.isTeamEvent) {
    const playerLines = parseBGMIPlayers(row)
      .map((p, i) => `  P${i + 1}: ${p.name || "N/A"} | DOB: ${p.dob || "N/A"}`)
      .join("\n");

    return [
      "📋 **REG Details**",
      `**Team Name:** ${row[3] || "N/A"}`,
      `**Email:** ${submission.email}`,
      `**Discord:** ${tag}`,
      "",
      "**Players:**",
      playerLines,
      "",
      "**Status:** ✅ Found in data",
    ].join("\n");
  }

  // Individual event — include chess.com rating for Chess tickets
  const lines = [
    "📋 **REG Details**",
    `**Name:** ${row[3] || "N/A"}`,
    `**DOB:** ${row[5] || "N/A"}`,
    `**Email:** ${submission.email}`,
    `**Discord:** ${tag}`,
  ];

  if (eventKey === "Chess" && submission.chessRating) {
    lines.push(`**Chess.com Rating:** ${submission.chessRating}`);
  }

  lines.push("**Status:** ✅ Found in data");

  return lines.join("\n");
}

/**
 * Reads a labelled field back out of a pinned message. Staff commands use
 * this to recover what the participant typed.
 */
export function parsePinnedField(
  content: string,
  label: string,
): string | undefined {
  const match = content.match(new RegExp(`\\*\\*${label}:\\*\\* (.+)`));
  return match?.[1]?.trim();
}

export function buildDocRequirements(eventKey: EventKey): string {
  const cfg = EVENTS[eventKey];

  if (cfg.mode === "direct-registration") {
    return [
      "Hi! Please share the following so we can verify your team:",
      "",
      "1. Mention your teammates in this message (type @theirname). Everyone you mention is added to this ticket, so they can post their own screenshot too.",
      "2. IGN and UID for every player (4-5 players), one line each:",
      "   IGN 1: ...",
      "   UID 1: ...",
      "   IGN 2: ...",
      "   UID 2: ...",
      "3. A screenshot of each player's account page on <https://gamerscult.in/>",
      "   (see the example below)",
    ].join("\n");
  }

  const playerNote = cfg.isTeamEvent ? " for every player" : "";

  return [
    "Hi, please share these details for verification:",
    "",
    "1. Registration confirmation screenshot / email",
    `2. Front & back photo of Government ID${playerNote}`,
    "",
    "Accepted IDs: Aadhaar Card, Voter ID, or Birth Certificate.",
  ].join("\n");
}

/**
 * The example image that accompanies the request message.
 *
 * The file is passed in because it is downloaded and cached separately — see
 * utils/example-image.ts.
 */
export function buildRequestExamplePayload(
  filePath: string | null,
): { embeds: EmbedBuilder[]; files: string[] } | null {
  if (!filePath) return null;

  const embed = new EmbedBuilder()
    .setDescription("This is what we need for every player:")
    .setImage(`attachment://${basename(filePath)}`);

  return { embeds: [embed], files: [filePath] };
}
