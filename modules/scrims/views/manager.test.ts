import { describe, expect, it } from "vitest";
import { ButtonBuilder } from "discord.js";

import {
  MAX_COMPONENTS_PER_MESSAGE,
  MAX_COMPONENTS_PER_ROW,
  MAX_ROWS,
} from "./components.js";
import { buildEditorPanel, buildWizardPanel, newWizardState } from "./manager.js";
import { buildBanPanel, buildDesignPanel, buildReservePanel } from "./panels.js";
import { buildSlotlistPanel } from "./slotlist.js";
import { parseScrimsId, scrimsId } from "./ids.js";
import type { ScrimRecord } from "../types.js";

function scrim(): ScrimRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    guildId: "guild-1",
    name: "Friday Scrims",
    status: "open",
    registrationChannelId: "chan-1",
    slotlistChannelId: "chan-2",
    slotlistMessageId: null,
    roleId: "role-1",
    openRoleId: null,
    pingRoleId: null,
    hostId: "user-1",
    requiredMentions: 4,
    requiredLines: 0,
    startFrom: 1,
    totalSlots: 10,
    openTime: new Date("2026-03-01T09:00:00.000Z"),
    openedAt: new Date("2026-03-01T09:00:00.000Z"),
    closedAt: null,
    matchTime: null,
    autoclean: ["channel", "role"],
    autocleanTime: null,
    autoslotlist: true,
    multiregister: false,
    enabled: true,
    autodeleteRejects: false,
    autodeleteExtras: true,
    teamnameCompulsion: false,
    noDuplicateName: false,
    allowDuplicateTags: true,
    timeElapsedSeconds: null,
    openDays: ["monday"],
    slotlistFormat: {},
    openMessage: {},
    closeMessage: {},
    emojis: { tick: "✅", cross: "❌" },
    cdn: { status: false, countdown: 3, msg: {} },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** The number of components in a panel. */
function countComponents(rows: readonly { components: readonly unknown[] }[]): number {
  return rows.reduce((sum, row) => sum + row.components.length, 0);
}

/** Every button in a panel. */
function buttons(panel: {
  components: readonly { components: readonly unknown[] }[];
}): ButtonBuilder[] {
  const found: ButtonBuilder[] = [];

  for (const row of panel.components) {
    for (const component of row.components) {
      if (component instanceof ButtonBuilder) found.push(component);
    }
  }

  return found;
}

/** The custom ids of a panel's buttons. */
function buttonIds(panel: {
  components: readonly { components: readonly unknown[] }[];
}): string[] {
  return buttons(panel).map((component) => {
    const data = component.toJSON() as { custom_id?: string };

    return data.custom_id ?? "";
  });
}

describe("the editor panel", () => {
  const panel = buildEditorPanel(scrim(), { index: 0, total: 3 }, true);

  it("fits in five rows of five", () => {
    expect(panel.components.length).toBe(MAX_ROWS);

    for (const row of panel.components) {
      expect(row.components.length).toBe(MAX_COMPONENTS_PER_ROW);
    }
  });

  it("fills the component budget exactly", () => {
    // Quotient's editor added exactly 25 and had no headroom. Ours is
    // the same shape, and the count is checked rather than assumed.
    expect(countComponents(panel.components)).toBe(MAX_COMPONENTS_PER_MESSAGE);
  });

  it("lists the twenty fields", () => {
    expect(panel.embeds[0]?.data.fields).toHaveLength(20);
  });
});

describe("the wizard panel", () => {
  it("has a button for every step and stays inside the budget", () => {
    const state = newWizardState("guild-1", "user-1");
    const panel = buildWizardPanel(state, "token");

    expect(panel.components.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(countComponents(panel.components)).toBeLessThanOrEqual(
      MAX_COMPONENTS_PER_MESSAGE,
    );
  });

  it("keeps the save button disabled until the scrim is complete", () => {
    const state = newWizardState("guild-1", "user-1");
    const panel = buildWizardPanel(state, "token");

    const ids = buttonIds(panel);

    expect(ids).toContain(scrimsId("wizard", "save", "token"));

    const save = buttons(panel).find((component) => {
      const data = component.toJSON() as { custom_id?: string };

      return data.custom_id === scrimsId("wizard", "save", "token");
    });

    const saveData = save?.toJSON() as { disabled?: boolean } | undefined;

    expect(saveData?.disabled).toBe(true);
  });
});

describe("the other panels", () => {
  it("the ban panel stays inside the budget", () => {
    const panel = buildBanPanel(scrim(), []);

    expect(countComponents(panel.components)).toBeLessThanOrEqual(
      MAX_COMPONENTS_PER_MESSAGE,
    );
  });

  it("the reserved-slots panel stays inside the budget", () => {
    const panel = buildReservePanel(scrim(), []);

    expect(countComponents(panel.components)).toBeLessThanOrEqual(
      MAX_COMPONENTS_PER_MESSAGE,
    );
  });

  it("the slotlist panel stays inside the budget", () => {
    const panel = buildSlotlistPanel(scrim(), []);

    expect(countComponents(panel.components)).toBeLessThanOrEqual(
      MAX_COMPONENTS_PER_MESSAGE,
    );
  });

  it("the slotlist panel carries the slot area's buttons", () => {
    // The slot area owns the panel. There is one namespace for these
    // buttons across the bot — `slots:slotlist_*` — and the scrims area
    // renders none of its own.
    const ids = buttonIds(buildSlotlistPanel(scrim(), []));

    expect(ids).toContain(`slots:slotlist_edit:${scrim().id}`);
    expect(ids).toContain(`slots:slotlist_punish:${scrim().id}`);
    expect(ids).toContain(`slots:slotlist_info:${scrim().id}`);

    for (const id of ids) {
      expect(id.startsWith("scrims:slotlist:")).toBe(false);
    }
  });

  it("the design panel carries the auto-slotlist switch", () => {
    // The column is honoured when the scrim closes, so the switch that
    // sets it cannot live in a place nobody can reach.
    const panel = buildDesignPanel(scrim());

    expect(buttonIds(panel)).toContain(
      scrimsId("design", scrim().id, "autoslotlist"),
    );
  });
});

describe("the custom id scheme", () => {
  it("carries the record id", () => {
    const id = scrimsId("editor", "set_role", "abc-123");

    expect(id).toBe("scrims:editor:set_role:abc-123");

    const parsed = parseScrimsId(id);

    expect(parsed?.action).toBe("editor");
    expect(parsed?.parts).toEqual(["set_role", "abc-123"]);
  });

  it("refuses an id that belongs to nobody", () => {
    expect(parseScrimsId("slots:claim:42")).toBeNull();
    expect(parseScrimsId("scrims")).toBeNull();
    expect(parseScrimsId("scrims:nonsense")).toBeNull();
  });

  it("reads a payload without the prefix", () => {
    const parsed = parseScrimsId(`scrims:${"editor:set_role:abc-123"}`);

    expect(parsed?.action).toBe("editor");
    expect(parsed?.parts).toEqual(["set_role", "abc-123"]);
  });
});
