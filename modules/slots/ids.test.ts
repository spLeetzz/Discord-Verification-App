/**
 * The custom-id scheme and the panels.
 *
 * Two things the port promises about the ids:
 *
 *  - every id is namespaced `slots:<action>[:<payload>]` and the
 *    payload is the **record** the id refers to, so a panel survives a
 *    restart (D18);
 *  - the router never guesses an id's owner from its shape (D7), so an
 *    id from another area is not answered by this one.
 */

import { describe, expect, it } from "vitest";

import { clearRegistry, registeredPrefixes } from "../../core/router.js";
import { parseSlotsId, payloadOf, slotsId } from "./ids.js";
import { buildPublicEmbed, buildPublicRows } from "./views/panel.js";
import { buildManagerScrimsRows } from "./views/manager.js";
import {
  buildSlotListEditorRows,
  buildSlotListRows,
} from "./views/slotlist.js";
import { registerSlotsInteractions } from "./register.js";
import { makeManager, makeScrim } from "./fake-store.js";
import type { ClaimableScrim } from "./service.js";

const SCRIM_ID = "11111111-2222-3333-4444-555555555555";
const MANAGER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("the custom ids", () => {
  it("are namespaced", () => {
    expect(slotsId("claim", MANAGER_ID)).toBe(`slots:claim:${MANAGER_ID}`);
    expect(slotsId("slotlist_punish", SCRIM_ID)).toBe(
      `slots:slotlist_punish:${SCRIM_ID}`,
    );
  });

  it("carry the record they refer to", () => {
    const id = parseSlotsId(slotsId("claim", MANAGER_ID));

    expect(id?.action).toBe("claim");
    expect(payloadOf(id!)).toBe(MANAGER_ID);
  });

  it("parse back into the same parts", () => {
    const id = parseSlotsId(slotsId("slotlist_info", SCRIM_ID));

    expect(id).not.toBeNull();
    expect(id?.action).toBe("slotlist_info");
    expect(id?.parts).toEqual([SCRIM_ID]);
  });

  it("refuse an id from another area", () => {
    expect(parseSlotsId("scrims:slotlist:edit")).toBeNull();
    expect(parseSlotsId("verify_btn:FF")).toBeNull();
    expect(parseSlotsId("slots:")).toBeNull();
  });

  it("refuse an action this area does not know", () => {
    expect(parseSlotsId("slots:definitely_not_an_action")).toBeNull();
  });
});

describe("the public panel", () => {
  const claimable: ClaimableScrim[] = [
    {
      scrim: makeScrim({ id: SCRIM_ID }),
      lowestFreeNum: 3,
      freeCount: 2,
    },
  ];

  it("carries the manager's id on every button", () => {
    const rows = buildPublicRows(makeManager({ id: MANAGER_ID }), claimable);

    const ids = rows
      .flatMap((row) => row.components)
      .map((component) => (component as { data: { custom_id: string } }).data.custom_id);

    expect(ids).toEqual([
      `slots:claim:${MANAGER_ID}`,
      `slots:remind:${MANAGER_ID}`,
      `slots:idp:${MANAGER_ID}`,
      `slots:cancel:${MANAGER_ID}`,
    ]);
  });

  it("disables the claim button when there is nothing to claim", () => {
    const rows = buildPublicRows(makeManager({ id: MANAGER_ID }), []);

    const buttons = rows
      .flatMap((row) => row.components)
      .map((component) => component as { data: { custom_id: string; disabled?: boolean } });

    const claim = buttons.find(
      (button) => button.data.custom_id === `slots:claim:${MANAGER_ID}`,
    );

    expect(claim?.data.disabled).toBe(true);
  });

  it("disables the reminder button when reminders are off", () => {
    const rows = buildPublicRows(
      makeManager({ id: MANAGER_ID, allowReminders: false }),
      claimable,
    );

    const buttons = rows
      .flatMap((row) => row.components)
      .map((component) => component as { data: { custom_id: string; disabled?: boolean } });

    const remind = buttons.find(
      (button) => button.data.custom_id === `slots:remind:${MANAGER_ID}`,
    );

    expect(remind?.data.disabled).toBe(true);
  });

  it("disables everything when the manager is switched off", () => {
    const rows = buildPublicRows(
      makeManager({ id: MANAGER_ID, toggle: false }),
      claimable,
    );

    for (const row of rows) {
      for (const component of row.components) {
        const button = component as { data: { disabled?: boolean } };

        expect(button.data.disabled).toBe(true);
      }
    }
  });

  it("lists the free slots", () => {
    const embed = buildPublicEmbed(makeManager({ id: MANAGER_ID }), claimable);

    expect(embed.data.description).toContain("Slot 3");
    expect(embed.data.description).toContain("2 Slots");
  });
});

describe("the published slot list", () => {  it("carries the scrim's id on every button", () => {
    const rows = buildSlotListRows(SCRIM_ID);

    const ids = rows
      .flatMap((row) => row.components)
      .map(
        (component) => (component as { data: { custom_id: string } }).data.custom_id,
      );

    expect(ids).toEqual([
      `slots:slotlist_edit:${SCRIM_ID}`,
      `slots:slotlist_punish:${SCRIM_ID}`,
      `slots:slotlist_info:${SCRIM_ID}`,
    ]);
  });

  it("offers the three team operations in the editor", () => {
    const rows = buildSlotListEditorRows(SCRIM_ID);

    const ids = rows
      .flatMap((row) => row.components)
      .map(
        (component) => (component as { data: { custom_id: string } }).data.custom_id,
      );

    expect(ids).toEqual([
      `slots:slotlist_change:${SCRIM_ID}`,
      `slots:slotlist_add:${SCRIM_ID}`,
      `slots:slotlist_remove:${SCRIM_ID}`,
      `slots:slotlist_back:${SCRIM_ID}`,
    ]);
  });

  it("sends Back back to the list, not back into the editor", () => {
    // The editor's "Back" used to carry `slotlist_edit`, which opened
    // the editor again — the button the user had just come from.
    const rows = buildSlotListEditorRows(SCRIM_ID);

    const ids = rows
      .flatMap((row) => row.components)
      .map(
        (component) => (component as { data: { custom_id: string } }).data.custom_id,
      );

    expect(ids).not.toContain(`slots:slotlist_edit:${SCRIM_ID}`);
  });

  it("does not switch the slot manager off when Back is pressed", () => {
    // The scrims sub-panel's "Back" used to carry `manager_toggle`,
    // which switched the whole slot manager off.
    const manager = makeManager();

    const ids = buildManagerScrimsRows(manager)
      .flatMap((row) => row.components)
      .map(
        (component) => (component as { data: { custom_id: string } }).data.custom_id,
      );

    expect(ids).not.toContain(`slots:manager_toggle:${manager.id}`);
    expect(ids).toContain(`slots:manager_back:${manager.id}`);
  });
});

describe("the registration", () => {
  it("owns the slots prefix in all three registries", () => {
    clearRegistry();

    registerSlotsInteractions();

    const prefixes = registeredPrefixes();

    expect(prefixes.buttons).toContain("slots");
    expect(prefixes.selects).toContain("slots");
    expect(prefixes.modals).toContain("slots");
  });
});
