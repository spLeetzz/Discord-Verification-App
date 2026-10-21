/**
 * The select menus of the tournaments area.
 *
 * Two things are pinned here:
 *
 *  1. **The manager panel's menu is routed.** Its custom id is
 *     `tourneys:select:pick`, so the *action* is `"select"` and the
 *     sub-action is in the parts. The handler used to compare the
 *     action with `"pick"`, so the menu always refused with "That menu
 *     is no longer active" — the panel's tournament picker was dead.
 *  2. **The slot manager's menu opens the rename modal.** The menu is
 *     persistent on purpose: a modal can only be shown on an
 *     interaction that has not been answered, and `core/select.ts`'s
 *     `awaitSelect` answers the interaction it opens — so a menu that
 *     is waited on inline cannot be followed by a modal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnySelectMenuInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
  repo: {
    getTourney: vi.fn(),
    listSlotsOfUser: vi.fn(),
  },
  handlers: {
    fail: vi.fn(),
    refuseUnlessMod: vi.fn(),
  },
  manager: {
    buildTourneyPanel: vi.fn(),
  },
}));

vi.mock("../repo.js", () => mocks.repo);
vi.mock("./handlers.js", () => mocks.handlers);
vi.mock("./manager.js", () => mocks.manager);

const { handleTourneysSelect } = await import("./select-handlers.js");

/** A select-menu interaction that answers the ways the handler uses. */
function selectInteraction(
  values: string[],
  userId = "user-1",
): AnySelectMenuInteraction & {
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  showModal: ReturnType<typeof vi.fn>;
} {
  return {
    user: { id: userId },
    values,
    deferred: false,
    replied: false,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnySelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.handlers.refuseUnlessMod.mockResolvedValue(false);
  mocks.manager.buildTourneyPanel.mockReturnValue({ embeds: [], components: [] });
  mocks.repo.getTourney.mockResolvedValue({ id: "tourney-1" });
  mocks.repo.listSlotsOfUser.mockResolvedValue([
    { id: "slot-1", num: 3, teamName: "Team Awesome" },
  ]);
});

describe("the manager panel's menu", () => {
  it("is routed", async () => {
    const interaction = selectInteraction(["tourney-1"]);

    await handleTourneysSelect(interaction, "select", ["pick"]);

    expect(mocks.handlers.fail).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
  });

  it("refuses a menu it does not know", async () => {
    const interaction = selectInteraction(["tourney-1"]);

    await handleTourneysSelect(interaction, "select", ["nope"]);

    expect(mocks.handlers.fail).toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });
});

describe("the slot manager's menu", () => {
  it("opens the rename modal on the pick", async () => {
    const interaction = selectInteraction(["slot-1"]);

    await handleTourneysSelect(interaction, "slotm_pick", [
      "tourney-1",
      "user-1",
    ]);

    expect(mocks.handlers.fail).not.toHaveBeenCalled();

    expect(interaction.showModal).toHaveBeenCalled();

    const modal = interaction.showModal.mock.calls[0]?.[0] as {
      data: { custom_id: string };
    };

    // The modal carries the tournament and the slot, so the submit
    // handler knows what it is for.
    expect(modal.data.custom_id).toContain("rename");
    expect(modal.data.custom_id).toContain("tourney-1");
    expect(modal.data.custom_id).toContain("slot-1");
  });

  it("refuses a pick from anybody else", async () => {
    const interaction = selectInteraction(["slot-1"], "user-2");

    await handleTourneysSelect(interaction, "slotm_pick", [
      "tourney-1",
      "user-1",
    ]);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(mocks.handlers.fail).toHaveBeenCalled();
  });

  it("refuses a slot the member does not hold", async () => {
    mocks.repo.listSlotsOfUser.mockResolvedValue([]);

    const interaction = selectInteraction(["slot-1"]);

    await handleTourneysSelect(interaction, "slotm_pick", [
      "tourney-1",
      "user-1",
    ]);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(mocks.handlers.fail).toHaveBeenCalled();
  });
});
