/**
 * The channel and role pickers of the scrims panels.
 *
 * These flows used to use a local copy of the pickers
 * (`views/select-flow.ts`). They use the **core** helpers now
 * (`core/select.ts`), and the core helpers have one rule the local copy
 * did not have: **a channel of another guild is not an answer.**
 *
 * Discord's channel select has no "guild mode" parameter, so the client
 * can hand back a channel of a guild the bot is in but this scrim is
 * not. The local copy took it and wrote it into the scrim, which put a
 * foreign channel id into a scrim of this guild — a row the bot could
 * never read. The core helper refuses it, the menu stays live for the
 * moderator, and the pick that follows is taken.
 *
 * What is pinned here:
 *
 *  1. the wizard's channel and role fields still work;
 *  2. the editor's channel field still writes the channel that was
 *     picked;
 *  3. **a channel of another guild is refused** — the pick is not
 *     accepted, and the foreign channel is never written.
 *
 * The interactions go through the **real router**, so the custom ids are
 * routed the way they are in production.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
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
}));

vi.mock("../repo.js", () => mocks.repo);
vi.mock("./handlers.js", () => mocks.handlers);

const { registerScrimsInteractions } = await import("../register.js");
const { dispatch } = await import("../../../core/router.js");
const { newWizardState, wizardStore } = await import("./manager.js");
const { scrimsId } = await import("./ids.js");

const MOD_ID = "mod-1";
const GUILD_ID = "guild-1";
const SCRIM_ID = "11111111-2222-3333-4444-555555555555";

/** A channel of this guild. */
const LOCAL_CHANNEL = "channel-local";

/** A channel of another guild. */
const FOREIGN_CHANNEL = "channel-foreign";

/** A scrim, as the repo hands it over. */
function scrim() {
  return {
    id: SCRIM_ID,
    guildId: GUILD_ID,
    name: "Friday Scrims",
    status: "open",
    registrationChannelId: null,
    slotlistChannelId: null,
    slotlistMessageId: null,
    roleId: null,
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

/** One click on a menu. */
interface Click {
  readonly userId?: string;
  readonly values?: string[];
}

/**
 * A button interaction, with the reply mechanics of the core fake.
 *
 * The fake stands in for Discord: its collector takes the first click
 * its **filter** accepts, so a click the filter refuses is not an answer
 * and the collector keeps waiting — the way discord.js does it.
 */
function buttonInteraction(options: {
  customId: string;
  clicks?: readonly Click[];
  selectValues?: string[];
  userId?: string;
}) {
  const ownerId = options.userId ?? MOD_ID;

  const fake = fakeInteraction({
    guildId: GUILD_ID,
    userId: ownerId,
    channelGuilds: {
      [LOCAL_CHANNEL]: GUILD_ID,
      [FOREIGN_CHANNEL]: "guild-2",
    },
    clicks: options.clicks,
    selectValues: options.selectValues,
  });

  const edit = vi.fn().mockResolvedValue(undefined);

  const interaction = {
    get deferred(): boolean {
      return fake.interaction.deferred;
    },
    get replied(): boolean {
      return fake.interaction.replied;
    },
    user: { id: ownerId },
    guildId: GUILD_ID,
    client: fake.interaction.client,
    customId: options.customId,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    message: { edit },
    reply: fake.reply,
    editReply: fake.editReply,
    followUp: fake.followUp,
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;

  return { interaction, fake, edit };
}

/** A wizard, and the token that points at it. */
function wizard() {
  const state = newWizardState(GUILD_ID, MOD_ID);

  return { state, token: wizardStore.issue(state) };
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
  mocks.repo.updateScrim.mockResolvedValue(undefined);
});

describe("the wizard's pickers", () => {
  it("sets the registration channel to the channel that was picked", async () => {
    const { state, token } = wizard();

    const { interaction, fake } = buttonInteraction({
      customId: scrimsId("wizard", "set_reg_channel", token),
      clicks: [{ values: [LOCAL_CHANNEL] }],
    });

    await dispatch(interaction);

    expect(state.registrationChannelId).toBe(LOCAL_CHANNEL);

    // The slotlist channel follows the registration channel until it is
    // set on its own.
    expect(state.slotlistChannelId).toBe(LOCAL_CHANNEL);

    // The menu was a channel menu, and it was ephemeral.
    expect(fake.sent[0]?.method).toBe("reply");
  });

  it("sets the role to the role that was picked", async () => {
    const { state, token } = wizard();

    const { interaction } = buttonInteraction({
      customId: scrimsId("wizard", "set_role", token),
      clicks: [{ values: ["role-1"] }],
    });

    await dispatch(interaction);

    expect(state.roleId).toBe("role-1");
  });

  it("refuses a channel of another guild", async () => {
    const { state, token } = wizard();

    const { interaction, fake } = buttonInteraction({
      customId: scrimsId("wizard", "set_reg_channel", token),
      // The moderator picks a channel of another guild first, and one of
      // this guild second.
      clicks: [
        { values: [FOREIGN_CHANNEL] },
        { values: [LOCAL_CHANNEL] },
      ],
    });

    await dispatch(interaction);

    const clicks = fake.sent[0]?.handle.clicks ?? [];

    // The foreign channel is not an answer: the collector keeps waiting.
    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[1]?.accepted).toBe(true);

    // And it is never written. The pick that follows is the one that
    // counts.
    expect(state.registrationChannelId).toBe(LOCAL_CHANNEL);
    expect(state.registrationChannelId).not.toBe(FOREIGN_CHANNEL);
  });
});

describe("the editor's pickers", () => {
  it("writes the channel that was picked", async () => {
    const { interaction } = buttonInteraction({
      customId: scrimsId("editor", "set_reg_channel", SCRIM_ID),
      clicks: [{ values: [LOCAL_CHANNEL] }],
    });

    await dispatch(interaction);

    expect(mocks.repo.updateScrim).toHaveBeenCalledWith(SCRIM_ID, {
      registrationChannelId: LOCAL_CHANNEL,
    });
  });

  it("does not write a channel of another guild", async () => {
    const { interaction, fake } = buttonInteraction({
      customId: scrimsId("editor", "set_reg_channel", SCRIM_ID),
      clicks: [
        { values: [FOREIGN_CHANNEL] },
        { values: [LOCAL_CHANNEL] },
      ],
    });

    await dispatch(interaction);

    const clicks = fake.sent[0]?.handle.clicks ?? [];

    expect(clicks[0]?.accepted).toBe(false);

    // The write carries the channel that was accepted, never the foreign
    // one.
    expect(mocks.repo.updateScrim).toHaveBeenCalledTimes(1);
    expect(mocks.repo.updateScrim).toHaveBeenCalledWith(SCRIM_ID, {
      registrationChannelId: LOCAL_CHANNEL,
    });
  });
});
