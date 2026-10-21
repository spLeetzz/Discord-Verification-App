/**
 * The slotlist editor's "Add Team" and "Change Team" flows.
 *
 * **The bug these tests pin.** Both flows used to call `awaitSelect`
 * and then `interaction.showModal(...)` on the *same* interaction.
 * `awaitSelect` answers the select interaction it opens — that is how
 * it collects the value — so `showModal` on it is a hard error
 * (`InteractionAlreadyReplied`): the flows threw every time a moderator
 * used them.
 *
 * The fix is the **persistent menu**: the choice is made with a real
 * component in the panel's own message, so the pick arrives as an
 * interaction of its own, still unanswered, and the modal is shown from
 * it. See `views/slot-pick.ts`.
 *
 * The interactions go through the **real router**, so the custom ids
 * are routed the way they are in production: the button's id opens the
 * menu, the menu's id opens the modal, and the modal's id applies the
 * change.
 *
 * What is pinned here:
 *
 *  1. the button press opens a **menu**, not a modal;
 *  2. the pick opens the modal, and the modal's token carries the
 *     scrim, the slot and the member who asked;
 *  3. the submit applies the team name and the new leader;
 *  4. a pick from **another moderator** is refused and drives nothing;
 *  5. the flow is the same whether the menu went onto the panel's
 *     message or into a follow-up.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";

const mocks = vi.hoisted(() => ({
  repo: {
    getScrim: vi.fn(),
    getSlot: vi.fn(),
    listSlots: vi.fn(),
    claimSlot: vi.fn(),
    changeSlotTeam: vi.fn(),
    listBans: vi.fn(),
    listScrims: vi.fn(),
    countScrims: vi.fn(),
    updateScrim: vi.fn(),
    setSlotState: vi.fn(),
  },
  handlers: {
    fail: vi.fn(),
    refuseUnlessMod: vi.fn(),
    acknowledgeAndRender: vi.fn(),
    renderPanel: vi.fn(),
    updatePanel: vi.fn(),
    scrimPosition: vi.fn(),
    readScrimsId: vi.fn(),
    loadScrim: vi.fn(),
  },
}));

vi.mock("../repo.js", () => mocks.repo);
vi.mock("./handlers.js", () => mocks.handlers);

const { registerScrimsInteractions } = await import("../register.js");
const { dispatch } = await import("../../../core/router.js");

const SCRIM_ID = "11111111-2222-3333-4444-555555555555";
const MOD_ID = "mod-1";
const OTHER_MOD_ID = "mod-2";
const SLOT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A scrim, as the repo hands it over. */
function scrim() {
  return {
    id: SCRIM_ID,
    guildId: "guild-1",
    name: "Friday Scrims",
    status: "open",
    registrationChannelId: "chan-1",
    slotlistChannelId: "chan-2",
    slotlistMessageId: null,
    roleId: "role-1",
    openRoleId: null,
    pingRoleId: null,
    hostId: MOD_ID,
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

/** A slot, as the repo hands it over. */
function slot(state: "free" | "claimed") {
  return {
    id: SLOT_ID,
    scrimId: SCRIM_ID,
    num: 3,
    state,
    teamName: state === "claimed" ? "Old Team" : null,
    ownerUserId: state === "claimed" ? "captain-1" : null,
    members: state === "claimed" ? ["captain-1"] : [],
    messageId: null,
    jumpUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A button interaction. */
function buttonInteraction(
  options: { userId?: string; replied?: boolean } = {},
): ButtonInteraction & {
  customId: string;
  update: ReturnType<typeof vi.fn>;
  showModal: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    customId: `scrims:slotlist:${SCRIM_ID}:change_team`,
    user: { id: options.userId ?? MOD_ID },
    deferred: false,
    replied: options.replied ?? false,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    customId: string;
    update: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

/** A select-menu interaction — the pick. */
function selectInteraction(
  customId: string,
  values: string[],
  userId = MOD_ID,
): AnySelectMenuInteraction & {
  customId: string;
  showModal: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    customId,
    user: { id: userId },
    values,
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => true,
    isModalSubmit: () => false,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    showModal: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnySelectMenuInteraction & {
    customId: string;
    showModal: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

/** A modal-submit interaction. */
function modalInteraction(
  customId: string,
  fields: Record<string, string>,
  userId = MOD_ID,
): ModalSubmitInteraction & { customId: string } {
  return {
    customId,
    user: { id: userId },
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => true,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    fields: {
      getTextInputValue: (id: string) => fields[id] ?? "",
    },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModalSubmitInteraction & { customId: string };
}

/** The persistent menu in a payload, if it carries one. */
function menuOf(payload: unknown): {
  custom_id: string;
  options: { value: string }[];
} | null {
  const rows =
    (payload as { components?: { toJSON(): { components?: unknown[] } }[] })
      .components ?? [];

  for (const row of rows) {
    const json = row.toJSON();

    for (const component of json.components ?? []) {
      const data = component as {
        custom_id?: string;
        options?: { value: string }[];
      };

      if (data.custom_id?.startsWith("scrims:slotm_pick")) {
        return { custom_id: data.custom_id, options: data.options ?? [] };
      }
    }
  }

  return null;
}

/** The custom id of the modal a pick opened. */
function modalIdOf(showModal: ReturnType<typeof vi.fn>): string {
  const modal = showModal.mock.calls[0]?.[0] as {
    data: { custom_id: string };
  };

  return modal.data.custom_id;
}

/** Presses the slotlist editor's button and returns the menu it opened. */
async function pressSlotlistButton(
  action: "add_team" | "change_team",
  options: { userId?: string; replied?: boolean } = {},
): Promise<{
  interaction: ButtonInteraction & { showModal: ReturnType<typeof vi.fn> };
  menu: { custom_id: string; options: { value: string }[] };
}> {
  const interaction = buttonInteraction(options);

  interaction.customId = `scrims:slotlist:${SCRIM_ID}:${action}`;

  await dispatch(interaction);

  const payload =
    interaction.update.mock.calls[0]?.[0] ??
    interaction.followUp.mock.calls[0]?.[0];

  const menu = menuOf(payload);

  if (!menu) throw new Error("the button did not open a menu");

  return { interaction, menu };
}

beforeAll(() => {
  registerScrimsInteractions();
});

beforeEach(() => {
  vi.clearAllMocks();

  mocks.handlers.refuseUnlessMod.mockResolvedValue(false);
  mocks.repo.getScrim.mockResolvedValue(scrim());
  mocks.repo.listSlots.mockResolvedValue([slot("free"), slot("claimed")]);
  mocks.repo.getSlot.mockResolvedValue(slot("claimed"));
  mocks.repo.claimSlot.mockResolvedValue(slot("claimed"));
  mocks.repo.changeSlotTeam.mockResolvedValue(slot("claimed"));
  mocks.repo.listBans.mockResolvedValue([]);
});

describe("the slotlist editor's team flows", () => {
  it("'Change Team' opens a menu, not a modal", async () => {
    // The bug: the button press used to answer the interaction with a
    // menu and then try to show a modal on the same, answered
    // interaction. The press now opens a menu and stops there.
    const { interaction, menu } = await pressSlotlistButton("change_team");

    expect(interaction.showModal).not.toHaveBeenCalled();

    // The id carries the scrim, the kind and the member who asked.
    expect(menu.custom_id).toBe(`scrims:slotm_pick:${SCRIM_ID}:change:${MOD_ID}`);

    // The claimed slots are on offer.
    expect(menu.options.map((option) => option.value)).toEqual([SLOT_ID]);
  });

  it("'Add Team' offers the free slots", async () => {
    const { interaction, menu } = await pressSlotlistButton("add_team");

    expect(interaction.showModal).not.toHaveBeenCalled();

    expect(menu.custom_id).toBe(`scrims:slotm_pick:${SCRIM_ID}:add:${MOD_ID}`);
  });

  it("the pick opens the modal", async () => {
    const { menu } = await pressSlotlistButton("change_team");

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    expect(mocks.handlers.fail).not.toHaveBeenCalled();
    expect(pick.showModal).toHaveBeenCalled();

    // The modal's token carries the state the pick collected.
    const modalId = modalIdOf(pick.showModal);

    expect(modalId.startsWith("scrims:modal:slot_team:")).toBe(true);
  });

  it("the submit applies the team name and the new leader", async () => {
    const { menu } = await pressSlotlistButton("change_team");

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    await dispatch(
      modalInteraction(
        modalIdOf(pick.showModal),
        {
          team_name: "New Team",
          leader: "<@222222222222222222>",
        },
      ),
    );

    expect(mocks.repo.changeSlotTeam).toHaveBeenCalledWith(SLOT_ID, {
      teamName: "New Team",
      ownerUserId: "222222222222222222",
      members: ["222222222222222222"],
    });

    expect(mocks.repo.claimSlot).not.toHaveBeenCalled();
  });

  it("'Add Team' claims the free slot", async () => {
    mocks.repo.getSlot.mockResolvedValue(slot("free"));

    const { menu } = await pressSlotlistButton("add_team");

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    await dispatch(
      modalInteraction(
        modalIdOf(pick.showModal),
        {
          team_name: "Brand New",
          leader: "<@333333333333333333>",
        },
      ),
    );

    expect(mocks.repo.claimSlot).toHaveBeenCalledWith(SCRIM_ID, 3, {
      teamName: "Brand New",
      ownerUserId: "333333333333333333",
      members: ["333333333333333333"],
      messageId: null,
      jumpUrl: null,
    });

    expect(mocks.repo.changeSlotTeam).not.toHaveBeenCalled();
  });

  it("refuses a pick from another moderator", async () => {
    const { menu } = await pressSlotlistButton("change_team");

    // Somebody else's click on the same menu.
    const otherPick = selectInteraction(menu.custom_id, [SLOT_ID], OTHER_MOD_ID);

    await dispatch(otherPick);

    expect(otherPick.showModal).not.toHaveBeenCalled();
    expect(mocks.handlers.fail).toHaveBeenCalled();

    // And nothing was written.
    expect(mocks.repo.changeSlotTeam).not.toHaveBeenCalled();
    expect(mocks.repo.claimSlot).not.toHaveBeenCalled();
  });

  it("refuses a form that belongs to somebody else", async () => {
    const { menu } = await pressSlotlistButton("change_team");

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    // The form is submitted by somebody else — the token says it is not
    // theirs.
    await dispatch(
      modalInteraction(
        modalIdOf(pick.showModal),
        { team_name: "Hijacked" },
        OTHER_MOD_ID,
      ),
    );

    expect(mocks.repo.changeSlotTeam).not.toHaveBeenCalled();
    expect(mocks.handlers.fail).toHaveBeenCalled();
  });

  it("works when the menu went into a follow-up", async () => {
    // The button press has already answered, so the menu cannot go onto
    // the panel's message: it goes into a message of its own. The flow
    // is the same.
    const { interaction, menu } = await pressSlotlistButton("change_team", {
      replied: true,
    });

    expect(interaction.followUp).toHaveBeenCalled();

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    expect(pick.showModal).toHaveBeenCalled();
  });

  it("refuses a slot the menu did not offer", async () => {
    // The slot was taken while the menu was open: the flow refuses it
    // rather than guessing.
    mocks.repo.getSlot.mockResolvedValue({
      ...slot("free"),
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    });

    const { menu } = await pressSlotlistButton("change_team");

    const pick = selectInteraction(menu.custom_id, [SLOT_ID]);

    await dispatch(pick);

    expect(pick.showModal).not.toHaveBeenCalled();
    expect(mocks.handlers.fail).toHaveBeenCalled();
  });
});
