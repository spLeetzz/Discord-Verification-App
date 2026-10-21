/**
 * The sub-panels: bans, reserved slots, autoclean, the message design
 * and the slotlist editor.
 *
 * Each one is a render of the row it belongs to, and each button is a
 * state transition on that row.
 *
 * **The shape every panel here has.** One main action, alone on the
 * first row, coloured by what it does — green creates, red destroys,
 * blurple is a plain action. The rows below it group the other actions
 * by meaning, and the last row is the way back, always grey.
 *
 * The embeds follow the same rule: a title, a short description, the
 * data as fields, and a footer that says what to do next — so the
 * description does not have to shout it.
 */

import type { EmbedBuilder } from "discord.js";
import {
  actionRow,
  dangerButton,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";
import { discordTimestamp } from "../../../core/time.js";
import { plural } from "../../../core/text.js";
import { BAN_MODES, BAN_MODE_LABELS } from "../types.js";
import type { BannedTeamRecord, ScrimRecord } from "../types.js";
import { isEmptyTemplate } from "../template.js";
import { assertComponentBudget } from "./components.js";
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
  const embed = panelEmbed({
    title: `Bans — ${scrim.name}`,
    description:
      bans.length === 0
        ? "Nobody is banned from this scrim."
        : bans
            .map(
              (ban, index) =>
                `🔴 \`${String(index + 1).padStart(2, "0")}\` <@${ban.userId}> \`${ban.userId}\` — ${
                  ban.expires ? `banned until ${discordTimestamp(ban.expires, "f")}` : "banned for good"
                }`,
            )
            .join("\n"),
    footer: "Ban a team to keep it out of this scrim.",
  });

  const rows: PanelComponents = [
    // The main action: a ban is the thing the panel is for, and it is
    // the one action here that cannot be taken back by a press.
    actionRow(
      dangerButton({
        customId: scrimsId("ban", scrim.id, "ban"),
        label: "Ban users",
      }),
    ),
    actionRow(
      successButton({
        customId: scrimsId("ban", scrim.id, "unban"),
        label: "Unban user",
        disabled: bans.length === 0,
      }),
      secondaryButton({
        customId: scrimsId("ban", scrim.id, "unban_all"),
        label: "Unban all",
        disabled: bans.length === 0,
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
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
  const first = scrim.startFrom;
  const last = scrim.startFrom + scrim.totalSlots - 1;

  const embed = panelEmbed({
    title: `Reserved slots — ${scrim.name}`,
    description: `Slots ${first} to ${last} — ${plural(reserved.length, "slot")} reserved.`,
    fields: reserved.map((slot) => ({
      name: `Slot ${String(slot.num).padStart(2, "0")}`,
      value: [
        slot.teamName ?? "Reserved",
        slot.userId ? `<@${slot.userId}>` : null,
        slot.expires
          ? `until ${discordTimestamp(slot.expires, "f")}`
          : "no expiry",
      ]
        .filter((part) => part !== null)
        .join(" · "),
    })),
    footer:
      reserved.length === 0
        ? "No slot is reserved — every slot is free."
        : "The free slots are the numbers not listed above.",
  });

  const rows: PanelComponents = [
    // The main action: a reservation is something that is created.
    actionRow(
      successButton({
        customId: scrimsId("reserve", scrim.id, "new"),
        label: "Reserve slot",
      }),
    ),
    actionRow(
      dangerButton({
        customId: scrimsId("reserve", scrim.id, "remove"),
        label: "Remove reservation",
        disabled: reserved.length === 0,
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
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
 *
 * A switch says what the press will do, so a button never reads as
 * "purge the channel" when it would actually switch the purge off. The
 * state of each switch is a field of the panel, right above it.
 */
export function buildAutocleanPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const purges = scrim.autoclean.includes("channel");
  const strips = scrim.autoclean.includes("role");

  const embed = panelEmbed({
    title: `Autoclean — ${scrim.name}`,
    description:
      "The pass runs every day, and only while the scrim closed less than 48 hours ago.",
    fields: [
      { name: "Purge channel", value: purges ? "On" : "Off", inline: true },
      { name: "Strip role", value: strips ? "On" : "Off", inline: true },
      {
        name: "Clean at",
        value: scrim.autocleanTime
          ? discordTimestamp(scrim.autocleanTime, "f")
          : "Not set",
        inline: true,
      },
    ],
    footer: "A switch turns the setting on or off.",
  });

  const rows: PanelComponents = [
    // The main action: the time of the pass is the one thing that has
    // to be set before the other two mean anything.
    actionRow(
      primaryButton({
        customId: scrimsId("autoclean", scrim.id, "time"),
        label: "Set clean time",
      }),
    ),
    actionRow(
      secondaryButton({
        customId: scrimsId("autoclean", scrim.id, "channel"),
        label: purges ? "Don't purge" : "Purge channel",
      }),
      secondaryButton({
        customId: scrimsId("autoclean", scrim.id, "role"),
        label: strips ? "Don't strip role" : "Strip role",
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/* ------------------------------------------------------------------ *
 * The design
 * ------------------------------------------------------------------ */

/**
 * The design panel: the three message templates, and the switch that
 * publishes the slotlist when the scrim closes.
 */
export function buildDesignPanel(
  scrim: ScrimRecord,
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const embed = panelEmbed({
    title: `Design — ${scrim.name}`,
    description:
      "The messages the bot posts when the scrim opens, when it closes, and when the slotlist goes out.",
    fields: [
      {
        name: "Open message",
        value: isEmptyTemplate(scrim.openMessage) ? "Default" : "Custom",
        inline: true,
      },
      {
        name: "Close message",
        value: isEmptyTemplate(scrim.closeMessage) ? "Default" : "Custom",
        inline: true,
      },
      {
        name: "Slotlist message",
        value: isEmptyTemplate(scrim.slotlistFormat) ? "Default" : "Custom",
        inline: true,
      },
      {
        name: "Publish the slotlist on close",
        value: scrim.autoslotlist ? "Yes" : "No",
        inline: true,
      },
    ],
    footer: "A field you leave empty keeps the default.",
  });

  const rows: PanelComponents = [
    // The main action: the open message is the one everybody reads
    // first.
    actionRow(
      primaryButton({
        customId: scrimsId("design", scrim.id, "open"),
        label: "Edit open message",
      }),
    ),
    actionRow(
      secondaryButton({
        customId: scrimsId("design", scrim.id, "close"),
        label: "Edit close message",
      }),
      secondaryButton({
        customId: scrimsId("design", scrim.id, "slotlist"),
        label: "Edit slotlist message",
      }),
      secondaryButton({
        customId: scrimsId("design", scrim.id, "autoslotlist"),
        label: scrim.autoslotlist
          ? "Don't publish slotlist"
          : "Publish slotlist on close",
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
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
  const embed = panelEmbed({
    title: `Edit slotlist — ${scrim.name}`,
    description:
      "Add a team to a free slot, change the team on a claimed one, or take a team off.",
    footer: "Pick a slot to add a team to, or to change the team on.",
  });

  const rows: PanelComponents = [
    // The main action: a team on a slot is something that is created.
    actionRow(
      successButton({
        customId: scrimsId("slotlist", scrim.id, "add_team"),
        label: "Add team",
      }),
    ),
    actionRow(
      secondaryButton({
        customId: scrimsId("slotlist", scrim.id, "change_team"),
        label: "Change team",
      }),
      dangerButton({
        customId: scrimsId("slotlist", scrim.id, "remove_team"),
        label: "Remove team",
      }),
    ),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
