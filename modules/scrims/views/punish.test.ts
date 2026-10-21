/**
 * The punish flow is not this area's any more.
 *
 * The **slot area** owns the published slot list, and with it the
 * **Punish** button — `slots:slotlist_punish`, its pick menus, its ban
 * type matrix and its ban log. The scrims area used to carry a second
 * copy of the flow: a `scrims:slotlist:<id>:punish` button, a
 * `punishSlot` handler that picked the slots, a `punishSelection` token
 * store and a `scrims:modal:punish` form that wrote the bans.
 *
 * **None of it was reachable.** The area renders the slot area's
 * buttons, so no `scrims:...:punish` button was ever on a message — and
 * the copy was broken besides: it answered the menu it opened and then
 * tried to show a modal on the same, already-answered interaction.
 *
 * What is pinned here:
 *
 *  1. a punish button press opens **no modal** and bans nobody;
 *  2. the punish form is **no longer answered** — it is refused the way
 *     every other unknown form is.
 *
 * The slot area's own punish flow is tested there.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { fakeInteraction } from "../../../core/interaction.fake.js";

const mocks = vi.hoisted(() => ({
  repo: {
    getScrim: vi.fn(),
    getSlot: vi.fn(),
    getScrimByRegistrationChannel: vi.fn(),
    getBanLogChannel: vi.fn(),
    listScrims: vi.fn(),
    countScrims: vi.fn(),
    listSlots: vi.fn(),
    listBans: vi.fn(),
    listReservedSlots: vi.fn(),
    updateScrim: vi.fn(),
    setSlotState: vi.fn(),
    claimSlot: vi.fn(),
    changeSlotTeam: vi.fn(),
    deleteScrim: vi.fn(),
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
  service: {
    banUsers: vi.fn(),
    unbanUser: vi.fn(),
    applyToAllScrims: vi.fn(),
    armDailyJobs: vi.fn(),
    armMatchTimer: vi.fn(),
    createScrimFromWizard: vi.fn(),
    reserveSlot: vi.fn(),
    removeReservation: vi.fn(),
  },
}));

vi.mock("../repo.js", () => mocks.repo);
vi.mock("./handlers.js", () => mocks.handlers);
vi.mock("../service.js", () => mocks.service);

const { registerScrimsInteractions } = await import("../register.js");
const { dispatch } = await import("../../../core/router.js");
const { scrimsId } = await import("./ids.js");

const SCRIM_ID = "11111111-2222-3333-4444-555555555555";
const MOD_ID = "mod-1";

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

/**
 * A button interaction, with the reply mechanics of the core fake.
 *
 * The fake collects a select menu the way discord.js does, so a handler
 * that opens one gets a real answer — which is what makes the "no modal"
 * assertion below a real pin and not a lucky accident.
 */
function buttonInteraction(customId: string): ButtonInteraction & {
  showModal: ReturnType<typeof vi.fn>;
} {
  const fake = fakeInteraction({
    guildId: "guild-1",
    userId: MOD_ID,
    selectValues: ["slot-1"],
  });

  return {
    customId,
    user: { id: MOD_ID },
    guildId: "guild-1",
    get deferred(): boolean {
      return fake.interaction.deferred;
    },
    get replied(): boolean {
      return fake.interaction.replied;
    },
    client: fake.interaction.client,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    reply: fake.reply,
    editReply: fake.editReply,
    followUp: fake.followUp,
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    showModal: ReturnType<typeof vi.fn>;
  };
}

/** A modal-submit interaction. */
function modalInteraction(customId: string): ModalSubmitInteraction {
  return {
    customId,
    user: { id: MOD_ID },
    guildId: "guild-1",
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => true,
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    fields: { getTextInputValue: () => "" },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModalSubmitInteraction;
}

beforeAll(() => {
  registerScrimsInteractions();
});

beforeEach(() => {
  vi.clearAllMocks();

  mocks.handlers.refuseUnlessMod.mockResolvedValue(false);
  mocks.handlers.scrimPosition.mockResolvedValue({ index: 0, total: 1 });
  mocks.repo.getScrim.mockResolvedValue(scrim());
  mocks.repo.listScrims.mockResolvedValue([scrim()]);
  mocks.repo.listSlots.mockResolvedValue([
    {
      id: "slot-1",
      scrimId: SCRIM_ID,
      num: 1,
      state: "claimed",
      teamName: "Old Team",
      ownerUserId: "captain-1",
      members: ["captain-1"],
      messageId: null,
      jumpUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  mocks.repo.listBans.mockResolvedValue([]);
});

describe("the punish flow", () => {
  it("is not answered by a punish button", async () => {
    // The old `punishSlot` handler picked the slots and then showed the
    // ban form. It is gone, so the press falls through to the panel.
    const interaction = buttonInteraction(
      scrimsId("slotlist", SCRIM_ID, "punish"),
    );

    await dispatch(interaction);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(mocks.service.banUsers).not.toHaveBeenCalled();
  });

  it("is not answered by the punish form", async () => {
    // The old `handlePunishModal` read the picked slots off a token
    // store and banned them. The form is gone, and an unknown form is
    // refused.
    const interaction = modalInteraction(
      scrimsId("modal", "punish", SCRIM_ID),
    );

    await dispatch(interaction);

    expect(mocks.handlers.fail).toHaveBeenCalledWith(
      interaction,
      "That form is no longer active.",
    );
    expect(mocks.service.banUsers).not.toHaveBeenCalled();
  });
});
