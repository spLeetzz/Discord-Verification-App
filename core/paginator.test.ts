/**
 * The paginator's registration with the router.
 *
 * A paginator is built every time a command runs, so it registers itself
 * with the router every time. That is not a duplicate — the handler is
 * the same for every paginator of a namespace, and it resolves the
 * paginator through a registry — and the router warns about duplicates,
 * so the paginator has to keep its registration to one.
 *
 * The other half is the reason the paginator resolves through a registry
 * at all: a paginator that is rebuilt (a command run twice) must not
 * leave the older message talking to a dead object.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ButtonInteraction } from "discord.js";
import { logger } from "../utils/logger.js";
import { clearRegistry, dispatch, registeredPrefixes } from "./router.js";
import {
  PAGER_ACTIONS,
  PAGER_CUSTOM_ID_PREFIX,
  Paginator,
  pagerCustomId,
} from "./paginator.js";

/** The warnings the router wrote. */
const warnings: string[] = [];

/**
 * A button interaction, for the dispatch tests.
 *
 * The paginator answers a press with an edit, so the fake needs an
 * `update` to write into.
 */
function fakeButton(customId: string): ButtonInteraction & { update: Mock } {
  const update = vi.fn().mockResolvedValue(undefined);

  return {
    customId,
    update,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
  } as unknown as ButtonInteraction & { update: Mock };
}

beforeEach(() => {
  warnings.length = 0;
  clearRegistry();

  vi.spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the paginator's router registration", () => {
  it("registers its prefix", () => {
    new Paginator({ namespace: "tags" });

    expect(registeredPrefixes().buttons).toContain(
      `${PAGER_CUSTOM_ID_PREFIX}:tags`,
    );
  });

  it("registers the prefix once, however many paginators are built", () => {
    new Paginator({ namespace: "tags" });
    new Paginator({ namespace: "tags" });

    const registered = registeredPrefixes().buttons.filter(
      (prefix) => prefix === `${PAGER_CUSTOM_ID_PREFIX}:tags`,
    );

    expect(registered).toHaveLength(1);
    // A rebuild is normal, so it must not read as a bug.
    expect(warnings).toEqual([]);
  });

  it("answers a press after the paginator has been rebuilt", async () => {
    new Paginator({
      namespace: "tags",
      loadPages: async () => [["old page"]],
    });

    new Paginator({
      namespace: "tags",
      loadPages: async () => [["new page"]],
    });

    const interaction = fakeButton(
      pagerCustomId("tags", PAGER_ACTIONS.next, 0),
    );

    await dispatch(interaction);

    expect(interaction.update).toHaveBeenCalledTimes(1);

    const payload = interaction.update.mock.calls[0]?.[0] as {
      embeds: { data: { description?: string } }[];
    };

    expect(payload.embeds[0]?.data.description).toBe("new page");
  });
});
