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
import { ButtonStyle } from "discord.js";
import type { ActionRowBuilder, ButtonBuilder, ButtonInteraction } from "discord.js";
import { logger } from "../utils/logger.js";
import { clearRegistry, dispatch, registeredPrefixes } from "./router.js";
import {
  PAGER_ACTIONS,
  PAGER_CUSTOM_ID_PREFIX,
  Paginator,
  buildPagerEmbed,
  buildPagerRow,
  pagerCustomId,
} from "./paginator.js";

/**
 * One button of a row, as the row carries it.
 */
interface RowButton {
  readonly label?: string;
  readonly style?: number;
  readonly custom_id?: string;
  readonly disabled?: boolean;
}

/**
 * The buttons of a row.
 *
 * Discord types a button as a union of the kinds there are, and only
 * one of them carries a custom id, so the row is read as the shape
 * this test cares about.
 */
function rowButtons(
  row: ActionRowBuilder<ButtonBuilder>,
): readonly RowButton[] {
  return row.toJSON().components as unknown as readonly RowButton[];
}

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

describe("the paginator's row", () => {
  it("is one row of grey navigation buttons", () => {
    // The paginator is the row under every list panel, so it reads as
    // one unit: four words, all of them grey.
    const buttons = rowButtons(buildPagerRow("tags", 1, 3));

    expect(buttons.map((button) => button.label)).toEqual([
      "First",
      "Previous",
      "Next",
      "Last",
    ]);

    for (const button of buttons) {
      expect(button.style).toBe(ButtonStyle.Secondary);
    }
  });

  it("keeps the custom ids the router matches on", () => {
    // The ids are the router's contract and the collector's contract.
    // They do not change.
    const buttons = rowButtons(buildPagerRow("tags", 1, 3));

    expect(buttons.map((button) => button.custom_id)).toEqual([
      "pager:tags:first:1",
      "pager:tags:previous:1",
      "pager:tags:next:1",
      "pager:tags:last:1",
    ]);
  });

  it("disables the buttons at the ends of the list", () => {
    // The disabled state is how the row says where the user is: there
    // is no page before the first one and none after the last one.
    const first = rowButtons(buildPagerRow("tags", 0, 3));

    expect(first[0]?.disabled).toBe(true);
    expect(first[1]?.disabled).toBe(true);
    expect(first[2]?.disabled).toBe(false);
    expect(first[3]?.disabled).toBe(false);

    const last = rowButtons(buildPagerRow("tags", 2, 3));

    expect(last[0]?.disabled).toBe(false);
    expect(last[1]?.disabled).toBe(false);
    expect(last[2]?.disabled).toBe(true);
    expect(last[3]?.disabled).toBe(true);
  });
});

describe("the paginator's panel", () => {
  it("puts the page count in the footer", () => {
    // The page indicator stays where it was: the footer, out of the way
    // of the list itself.
    const embed = buildPagerEmbed([["a"], ["b"], ["c"]], 1, {
      namespace: "tags",
      title: "Tags",
    });

    expect(embed.toJSON().title).toBe("Tags");
    expect(embed.toJSON().description).toBe("b");
    expect(embed.toJSON().footer?.text).toBe("Page 2 of 3");
  });

  it("names the list when the caller does not", () => {
    // A panel without a title is not a panel.
    const embed = buildPagerEmbed([["a"]], 0, { namespace: "tags" });

    expect(embed.toJSON().title).toBe("Results");
  });

  it("leaves the page count out when the caller asks it to", () => {
    const embed = buildPagerEmbed([["a"], ["b"]], 0, {
      namespace: "tags",
      title: "Tags",
      showPageCount: false,
    });

    expect(embed.toJSON().footer).toBeUndefined();
  });
});
