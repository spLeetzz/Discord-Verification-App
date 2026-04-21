import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { EVENTS } from "../config/events.js";

export function buildVerificationEmbed(eventKey) {
  const cfg = EVENTS[eventKey];
  return new EmbedBuilder()
    .setTitle(cfg.displayName)
    .setDescription(cfg.description)
    .setColor(0x229db7)
    .setImage(
      "https://media.discordapp.net/attachments/1495405063320113215/1495424946179145889/bssa_LOGO.png?ex=69e82cc2&is=69e6db42&hm=d7a05ea1f1657bbd9b1e18c0d52b308b7bca17105ff4e3ec70caf21bcdfe099f&=&format=webp&quality=lossless&width=1264&height=817",
    );
}

export function buildVerificationButtonRow(eventKey) {
  const btn = new ButtonBuilder()
    .setCustomId(`verify_btn:${eventKey}`)
    .setLabel("Start Verification")
    .setEmoji("📩")
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder().addComponents(btn);
}

export function buildVerificationModal(eventKey) {
  const cfg = EVENTS[eventKey];
  const modal = new ModalBuilder()
    .setCustomId(`verify_modal:${eventKey}`)
    .setTitle("Event Verification");

  const emailInput = new TextInputBuilder()
    .setCustomId("email")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("yourname@example.com")
    .setRequired(true);

  const emailLabel = new LabelBuilder()
    .setLabel("Email used at registration")
    .setTextInputComponent(emailInput);

  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(cfg.isTeamEvent ? "e.g. Team Phoenix" : "e.g. Rahul Sharma")
    .setRequired(true);

  const nameLabel = new LabelBuilder()
    .setLabel(cfg.isTeamEvent ? "Team Name" : "Your Full Name")
    .setTextInputComponent(nameInput);

  modal.addLabelComponents(emailLabel, nameLabel);
  return modal;
}

function parseBGMIPlayers(row) {
  const players = [];
  if (row[4]) players.push({ name: row[4], dob: row[6] });
  for (const s of [11, 17, 23, 29]) {
    if (!row[s]) break;
    players.push({ name: row[s], dob: row[s + 2] });
  }
  return players;
}

export function buildPinnedContent(user, eventKey, email, result) {
  const cfg = EVENTS[eventKey];
  const tag = `${user}`; // resolves to <@id> mention

  if (result.status === "not_found") {
    return [
      `📋 **REG Details**`,
      `**Email:** ${email}`,
      `**Discord:** ${tag}`,
      `**Status:** ❌ Not found in current sheet`,
    ].join("\n");
  }

  const row = result.rows[0];

  if (cfg.isTeamEvent) {
    const players = parseBGMIPlayers(row);
    const playerLines = players
      .map((p, i) => `  P${i + 1}: ${p.name || "N/A"} | DOB: ${p.dob || "N/A"}`)
      .join("\n");
    return [
      `📋 **REG Details**`,
      `**Team Name:** ${row[3] || "N/A"}`,
      `**Email:** ${email}`,
      `**Discord:** ${tag}`,
      ``,
      `**Players:**`,
      playerLines,
      ``,
      `**Status:** ✅ Found in data`,
    ].join("\n");
  }

  // Individual event
  return [
    `📋 **REG Details**`,
    `**Name:** ${row[3] || "N/A"}`,
    `**DOB:** ${row[5] || "N/A"}`,
    `**Email:** ${email}`,
    `**Discord:** ${tag}`,
    `**Status:** ✅ Found in data`,
  ].join("\n");
}

export function buildDocRequirements(eventKey) {
  const cfg = EVENTS[eventKey];
  const playerNote = cfg.isTeamEvent ? " for every player" : "";
  return [
    `Hi, please share these details for verification:`,
    ``,
    `1. Registration confirmation screenshot / email`,
    `2. Front & back photo of Government ID${playerNote}`,
    ``,
    `Accepted IDs: Aadhaar Card, Voter ID, or Birth Certificate.`,
  ].join("\n");
}
