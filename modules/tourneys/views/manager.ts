/**
 * The management panels.
 *
 * Two panels live here:
 *
 *  - the **manager panel**, which lists the guild's tournaments and lets
 *    a moderator pick one;
 *  - the **per-tournament panel**, which is the panel the source's
 *    `TourneyManager` showed once a tournament had been chosen.
 *
 * The source's manager asked the moderator to pick a tournament *every
 * time* they pressed a button (`Tourney.prompt_selector`), which meant
 * the panel could not survive a restart and two moderators could not see
 * each other's work. Ours carries the tournament's id in the custom id
 * (D18), so the panel is a render of the row and every button says which
 * tournament it acts on.
 *
 * **The panel is public** (D43): other moderators have to be able to see
 * it.
 *
 * **The empty state is the first thing a new server sees**, so it says
 * what to do rather than only reporting that there is nothing there.
 */

import { StringSelectMenuBuilder } from "discord.js";
import {
  actionRow,
  assertComponentBudget,
  componentRow,
  emptyPanel,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
  dangerButton,
} from "../../../core/ui.js";
import type { TourneyRecord, TourneyStatus } from "../types.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/** How many tournaments the select menu can offer. */
const MAX_MENU_OPTIONS = 25;

/**
 * The manager panel: the guild's tournaments and a way into each.
 */
export function buildManagerPanel(
  tourneys: readonly TourneyRecord[],
): Panel {
  const create = successButton({
    customId: tourneysId("wizard", "new"),
    label: "Create tournament",
  });

  const refresh = secondaryButton({
    customId: tourneysId("manager", "refresh"),
    label: "Refresh",
  });

  if (tourneys.length === 0) {
    // The empty state: it says what to do, and the button that does it
    // is right there.
    const empty = emptyPanel({
      title: "Tournament manager",
      description:
        "This server has no tournaments yet. Create one to start collecting registrations.",
      footer:
        "A tournament needs a registration channel, a confirm channel, a success role and a number of slots.",
      action: create,
    });

    const rows: PanelComponents = [...empty.components, navigationRow(refresh)];

    assertComponentBudget(rows);

    return { embeds: [...empty.embeds], components: rows };
  }

  const embed = panelEmbed({
    title: "Tournament manager",
    description: tourneys
      .map(
        (tourney, index) =>
          `\`${String(index + 1).padStart(2, "0")}.\` **${tourney.name}** — ${statusLabel(tourney.status)} — Slots: \`${tourney.totalSlots}\``,
      )
      .join("\n"),
    footer: "Pick a tournament to manage it, or create another one.",
  });

  const rows: PanelComponents = [];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(tourneysId("select", "pick"))
    .setPlaceholder("Choose a tournament to manage")
    .setMinValues(1)
    .setMaxValues(1);

  for (const tourney of tourneys.slice(0, MAX_MENU_OPTIONS)) {
    menu.addOptions({
      label: tourney.name.slice(0, 100),
      value: tourney.id,
      description: `${statusLabel(tourney.status)} — ${tourney.totalSlots} slots`.slice(
        0,
        100,
      ),
    });
  }

  rows.push(componentRow(menu));

  // Creating is green: it adds a tournament.
  rows.push(actionRow(create));

  // The navigation is grey and last.
  rows.push(navigationRow(refresh));

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * The panel of one tournament.
 *
 * Every button carries the tournament's id, so the panel survives a
 * restart and two moderators can work on the same tournament.
 */
export function buildTourneyPanel(tourney: TourneyRecord): Panel {
  const isOpen = tourney.status === "open";

  const embed = panelEmbed({
    title: `Tournament — ${tourney.name}`,
    description:
      "The tournament's registration, groups, slots and partners, in one place.",
    fields: [
      { name: "Status", value: statusLabel(tourney.status), inline: true },
      { name: "Slots", value: `\`${tourney.totalSlots}\``, inline: true },
      {
        name: "Teams per group",
        value: `\`${tourney.groupSize ?? "not set"}\``,
        inline: true,
      },
      {
        name: "Registration channel",
        value: `<#${tourney.registrationChannelId}>`,
        inline: true,
      },
      {
        name: "Confirm channel",
        value: `<#${tourney.confirmChannelId}>`,
        inline: true,
      },
      { name: "Success role", value: `<@&${tourney.roleId}>`, inline: true },
      {
        name: "Mentions required",
        value: `\`${tourney.requiredMentions}\``,
        inline: true,
      },
      {
        name: "Reactions",
        value: `${tourney.emojis.tick},${tourney.emojis.cross}`,
        inline: true,
      },
    ],
    footer: isOpen
      ? "Pick what to do next. The teams can register now."
      : "Pick what to do next. Open the registration to let the teams register.",
  });

  const rows: PanelComponents = [];

  // The first row holds the one thing to do next.
  rows.push(
    actionRow(
      primaryButton({
        customId: tourneysId("editor", tourney.id),
        label: "Edit settings",
      }),
    ),
  );

  // Opening the registration is green — it opens something. Pausing it
  // is neither green nor red: it is reversible.
  rows.push(
    actionRow(
      isOpen
        ? secondaryButton({
            customId: tourneysId("lifecycle", "toggle", tourney.id),
            label: "Pause registration",
          })
        : successButton({
            customId: tourneysId("lifecycle", "toggle", tourney.id),
            label: "Start registration",
          }),
      secondaryButton({
        customId: tourneysId("groups", tourney.id),
        label: "Manage groups",
      }),
      secondaryButton({
        customId: tourneysId("slotm", tourney.id),
        label: "Slot manager",
      }),
      secondaryButton({
        customId: tourneysId("partner", tourney.id),
        label: "Media partners",
      }),
      secondaryButton({
        customId: tourneysId("modal", "export", tourney.id),
        label: "Export CSV",
      }),
    ),
  );

  // The third row: the slot that can be added, and the three buttons
  // that destroy something. Adding a slot is green while the
  // registration is closed, because the green button is the one that
  // adds something — and once the registration is open, "Start
  // registration" is gone and this one takes the green.
  rows.push(
    actionRow(
      isOpen
        ? successButton({
            customId: tourneysId("modal", "add_slot", tourney.id),
            label: "Add slot",
          })
        : secondaryButton({
            customId: tourneysId("modal", "add_slot", tourney.id),
            label: "Add slot",
          }),
      dangerButton({
        customId: tourneysId("modal", "remove_slot", tourney.id),
        label: "Cancel a slot",
      }),
      dangerButton({
        customId: tourneysId("lifecycle", "close", tourney.id),
        label: "Close registration",
        disabled: tourney.status === "closed",
      }),
      dangerButton({
        customId: tourneysId("ban", tourney.id),
        label: "Ban or unban",
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/** The status, as a panel shows it. */
function statusLabel(status: TourneyStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "open":
      return "Open";
    case "paused":
      return "Paused";
    case "closed":
      return "Closed";
  }
}
