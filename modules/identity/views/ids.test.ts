/**
 * The custom-id scheme of the panel.
 *
 * The scheme is what the whole area's routing rests on: the builder
 * writes the surface and the action into fixed segments, the parser
 * reads them back from the same segments, and the handler switches on
 * what the parser returned.
 *
 * These tests pin the two halves together, and pin the rule that made
 * the old pair of prefixes dangerous: an id of one surface is never an
 * id of another, so no two of this area's ids can shadow each other.
 */

import { describe, expect, it } from "vitest";
import {
  SSMOD_ACTIONS,
  SSMOD_PREFIX,
  SSMOD_SURFACE_ACTIONS,
  parseSsModId,
  ssModCustomId,
} from "./ids.js";

/** The surfaces of the panel, in the order they are listed. */
const SURFACES = ["list", "edit", "wizard"] as const;

/**
 * The payload of a custom id — everything after the prefix.
 */
function payloadOf(customId: string): string {
  return customId.slice(SSMOD_PREFIX.length + 1);
}

describe("the id scheme", () => {
  it("builds one layout for every id", () => {
    expect(ssModCustomId("list", SSMOD_ACTIONS.setup)).toBe(
      "identity:ssmod:list:setup",
    );

    expect(ssModCustomId("edit", SSMOD_ACTIONS.delete, "config-1")).toBe(
      "identity:ssmod:edit:delete:config-1",
    );

    expect(ssModCustomId("wizard", SSMOD_ACTIONS.save, "token")).toBe(
      "identity:ssmod:wizard:save:token",
    );
  });

  it("reads back what it wrote", () => {
    for (const surface of SURFACES) {
      for (const action of SSMOD_SURFACE_ACTIONS[surface]) {
        const customId = ssModCustomId(surface, action, "target-1");

        expect(parseSsModId(payloadOf(customId))).toEqual({
          surface,
          action,
          target: "target-1",
        });
      }
    }
  });

  it("reads an id without a target back", () => {
    expect(parseSsModId("list:setup")).toEqual({
      surface: "list",
      action: "setup",
      target: null,
    });
  });

  it("refuses an action of another surface", () => {
    // The wizard's Save is not the editor's, and the editor's Delete is
    // not the wizard's. An id that mixes the two is not one of this
    // area's ids.
    expect(parseSsModId("edit:save:token")).toBeNull();
    expect(parseSsModId("wizard:delete:config-1")).toBeNull();
    expect(parseSsModId("list:delete:config-1")).toBeNull();
    expect(parseSsModId("list:set_channel:config-1")).toBeNull();
  });

  it("refuses an id that is not one of ours", () => {
    expect(parseSsModId(null)).toBeNull();
    expect(parseSsModId("")).toBeNull();
    expect(parseSsModId("nonsense")).toBeNull();
    expect(parseSsModId("tourneys:manager")).toBeNull();

    // The whole id is not the payload: the router hands over what comes
    // after the prefix.
    expect(parseSsModId("identity:ssmod:list:setup")).toBeNull();
  });

  it("gives the list panel's Setup button a surface of its own", () => {
    // The bug this scheme exists to prevent: the list panel's Setup
    // button and the wizard's ids must not be able to be mistaken for
    // each other.
    const setup = ssModCustomId("list", SSMOD_ACTIONS.setup);
    const save = ssModCustomId("wizard", SSMOD_ACTIONS.save, "token");

    expect(setup).toBe("identity:ssmod:list:setup");
    expect(parseSsModId(payloadOf(save))?.surface).toBe("wizard");
    expect(parseSsModId(payloadOf(setup))?.surface).toBe("list");
  });

  it("keeps every id under the one prefix", () => {
    for (const surface of SURFACES) {
      for (const action of SSMOD_SURFACE_ACTIONS[surface]) {
        expect(
          ssModCustomId(surface, action, "target-1").startsWith(
            `${SSMOD_PREFIX}:`,
          ),
        ).toBe(true);
      }
    }
  });
});
