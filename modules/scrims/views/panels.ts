/**
 * The sub-panels: bans, reserved slots, autoclean, the message design
 * and the slotlist editor.
 *
 * Each one is a render of the row it belongs to, and each button is a
 * state transition on that row.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { discordTimestamp, formatTimestamp } from "../../../core/time.js";
import { BAN_MODES, BAN_MODE_LABELS } from "../types.js";
import type { BannedTeamRecord, ScrimRecord } from "../types.js";
import { assertComponentBudget, button, buttonRow } from "./components.js";
import { scrimsId } from "./ids.js";
import type { PanelComponents } from "./manager.js";

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** The ban panel: ban, unban, unban everybody. */
export function buildBanPanel(
  scrim: ScrimRecord,
  bans: readonly BannedTeamRecord[],
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Ban / Unban — ${scrim.name}`)
    .setColor(EMBED_COLOR);

  if (bans.length === 0) {
    embed.setDescription("No banned user.");
  } else {
    embed.setDescription(
      bans
        .map(
          (ban, index) =>
            `\`${String(index + 1).padStart(2, "0")}.\` <@${ban.userId}> \`[${ban.userId}]\` — ${ban.expires ? discordTimestamp(ban.expires, "f") : "Lifetime"}`,
        )
        .join("\n"),
    );
  }

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("ban", scrim.id, "ban"),
        label: "Ban Users",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("ban", scrim.id, "unban"),
        label: "Unban Users",
        style: ButtonStyle.Success,
        disabled: bans.length === 0,
      }),
      button({
        customId: scrimsId("ban", scrim.id, "unban_all"),
        label: "Unban All",
        style: ButtonStyle.Primary,
        disabled: bans.length === 0,
      }),
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/** The four ban modes, as a select menu's options. */
export function banModeOptions(): {
  label: string;
  value: string;
  description: string;
}[] {
  return BAN_MODES.map((mode) => ({
    label: BAN_MODE_LABELS[mode].slice(0, 100),
    value: String(mode),
    description: BAN_MODE_LABELS[mode].slice(0, 100),
  }));
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** The reserved-slots panel. */
export function buildReservePanel(
  scrim: ScrimRecord,
  reserved: readonly {
    readonly id: string;
    readonly num: number;
    readonly teamName: string | null;
    readonly userId: string | null;
    readonly expires: Date | null;
  }[],
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Reserved Slots — ${scrim.name}`)
    .setColor(EMBED_COLOR);

  const lines: string[] = [];

  for (
    let num = scrim.startFrom;
    num < scrim.startFrom + scrim.totalSlots;
    num += 1
  ) {
    const entry = reserved.find((slot) => slot.num === num);

    const label = entry
      ? `${entry.teamName ?? "Reserved"} [${
          entry.expires ? formatTimestamp(entry.expires) : "Lifetime"
        }]`
      : "❌";

    lines.push(`Slot ${String(num).padStart(2, "0")}  -->  ${label}`);
  }

  embed.setDescription(`\`\`\`\n${lines.join("\n")}\n\`\`\``);

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("reserve", scrim.id, "new"),
        label: "Reserve Slot",
        style: ButtonStyle.Success,
      }),
      button({
        customId: scrimsId("reserve", scrim.id, "remove"),
        label: "Remove Reserved",
        style: ButtonStyle.Danger,
        disabled: reserved.length === 0,
      }),
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * Autoclean
 * ------------------------------------------------------------------ */

/**
 * The autoclean panel.
 *
 * Two independent toggles — purge the registration channel, and strip
 * the success role from everybody who holds it — plus the time the pass
 * runs at.
 */
export function buildAutocleanPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Scrim Autoclean — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        "```",
        `1. Purge channel   ${scrim.autoclean.includes("channel") ? "✅" : "❌"}`,
        `2. Strip role      ${scrim.autoclean.includes("role") ? "✅" : "❌"}`,
        `3. Clean at        ${
          scrim.autocleanTime
            ? formatTimestamp(scrim.autocleanTime)
            : "Not set"
        }`,
        "```",
        "The pass runs daily, and only while the scrim closed less than 48 hours ago.",
      ].join("\n"),
    );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("autoclean", scrim.id, "channel"),
        label: scrim.autoclean.includes("channel")
          ? "Don't purge"
          : "Purge channel",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("autoclean", scrim.id, "role"),
        label: scrim.autoclean.includes("role")
          ? "Don't strip role"
          : "Strip role",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("autoclean", scrim.id, "time"),
        label: "Clean At",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("editor", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * The design
 * ------------------------------------------------------------------ */

/** The design panel: the three message templates. */
export function buildDesignPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Scrims — Design Settings — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        "What do you want to design?",
        "",
        "**A** — Registration open message",
        "**B** — Registration close message",
        "**C** — Slotlist design",
      ].join("\n"),
    );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("design", scrim.id, "open"),
        label: "A",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("design", scrim.id, "close"),
        label: "B",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("design", scrim.id, "slotlist"),
        label: "C",
        emoji: "📝",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * The slotlist editor
 * ------------------------------------------------------------------ */

/**
 * The slotlist editor.
 *
 * "Add Team", "Remove Team" and "Change Team" are state transitions on
 * the `slots` table. The source's "Add Team" offered
 * `range(start_from, 30)` — twenty numbers that did not exist for a
 * scrim with fewer slots (B4). Ours offers the scrim's own numbers.
 */
export function buildSlotlistEditorPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = new EmbedBuilder()
    .setTitle(`Edit the slotlist — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription("Choose an option below to edit the slotlist.");

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("slotlist", scrim.id, "change_team"),
        label: "Change Team",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "remove_team"),
        label: "Remove Team",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "add_team"),
        label: "Add Team",
        style: ButtonStyle.Success,
      }),
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
