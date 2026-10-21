/**
 * The screenshot-verification panel.
 *
 * Two things are tested here.
 *
 * **The premium gates.** The entitlement is checked **before** the draft
 * or the row is changed, so a refused configuration is never persisted.
 * Quotient assigned the screenshot type to the record first and checked
 * afterwards, and the editor then wrote every field of the record on the
 * next interaction — so a free guild ended up with a premium type (B8).
 * The success message had no gate in the wizard at all (B12).
 *
 * **The authorisation.** The panel is a *message*: its buttons delete a
 * server's verification setup, repoint the channel the bot reads, change
 * the role the bot grants and set the text the bot posts. Anybody who can
 * read the channel can press them, so every handler checks the caller
 * itself — and the rows are looked up **in a guild**, so a row id on its
 * own never reaches another server's configuration.
 *
 * **The routing.** The last block presses every id the panel builds
 * through the **real** router, in two registration orders, and says what
 * each press did. The panel has one prefix, so the order cannot decide
 * which handler runs — and the test is what keeps it that way.
 *
 * The service is faked with a table that is keyed by the guild *and* the
 * row id, the way the repository is, so the assertions are about the
 * **state** — "the row is still there" — and not about the calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { PremiumRequiredError } from "../../../core/errors.js";
import { PremiumFeature } from "../../../core/constants.js";
import { logger } from "../../../utils/logger.js";
import type { SsConfig } from "../types.js";
import type { SsDraft } from "./ssmod.js";
import {
  SSMOD_ACTIONS,
  SSMOD_PREFIX,
  SSMOD_SURFACES,
} from "./ids.js";
import type {
  SsModEditAction,
  SsModId,
  SsModListAction,
  SsModWizardAction,
} from "./ids.js";

const mocks = vi.hoisted(() => ({
  service: {
    assertSsConfigAllowance: vi.fn(),
    assertScreenshotTypeAllowed: vi.fn(),
    assertSuccessMessageAllowed: vi.fn(),
    createSsConfig: vi.fn(),
    deleteSsConfig: vi.fn(),
    findSsConfig: vi.fn(),
    listSsConfigs: vi.fn(),
    updateSsConfig: vi.fn(),
  },
}));

vi.mock("../service.js", () => mocks.service);

const ssmod = await import("./ssmod.js");
const router = await import("../../../core/router.js");
const interactions = await import("../interactions.js");

/* ------------------------------------------------------------------ *
 * The fake table
 * ------------------------------------------------------------------ */

/** The setups the faked service knows about, keyed by guild and row id. */
const table = new Map<string, SsConfig>();

/** The key a setup is stored under. */
function key(guildId: string, id: string): string {
  return `${guildId}:${id}`;
}

/** A setup, as the table holds it. */
function makeSetup(guildId: string, id: string): SsConfig {
  return {
    id,
    guildId,
    channelId: "channel-1",
    roleId: "role-1",
    requiredSs: 2,
    channelName: "Team Phoenix",
    channelLink: "https://example.com/team-phoenix",
    keywords: ["Team Phoenix"],
    allowSame: false,
    ssType: "youtube",
    successMessage: null,
  };
}

/* ------------------------------------------------------------------ *
 * The fake interactions
 * ------------------------------------------------------------------ */

/** The member of the fake guild. */
interface FakeMember {
  readonly permissions: { has(flag: bigint): boolean };
  readonly roles: {
    readonly cache: {
      some(check: (role: { name: string }) => boolean): boolean;
    };
  };
}

/**
 * A member of the fake guild.
 *
 * @param admin whether the member has the administrator permission.
 * @param manageGuild whether the member may manage the server.
 * @param moderator whether the member holds the staff role.
 */
function fakeMember(options: {
  admin?: boolean;
  manageGuild?: boolean;
  moderator?: boolean;
}): FakeMember {
  const flags = new Set<bigint>();

  if (options.admin) flags.add(PermissionFlagsBits.Administrator);
  if (options.manageGuild) flags.add(PermissionFlagsBits.ManageGuild);

  const roles = options.moderator ? ["Moderator"] : [];

  return {
    permissions: { has: (flag: bigint) => flags.has(flag) },
    roles: {
      cache: {
        some: (check) => roles.some((name) => check({ name })),
      },
    },
  };
}

/** The ordinary member: no permissions, no staff role. */
const ORDINARY_MEMBER = fakeMember({});

/** The moderator: the staff role the guild already uses. */
const MODERATOR = fakeMember({ moderator: true });

/** The administrator. */
const ADMINISTRATOR = fakeMember({ admin: true });

/** The id of the member who presses the buttons. */
const USER_ID = "user-1";

/** The guild the panel belongs to. */
const GUILD_ID = "guild-1";

/** Another guild. */
const OTHER_GUILD_ID = "guild-2";

/**
 * A guild with one member in it.
 */
function fakeGuild(
  guildId: string,
  member: FakeMember | null,
): Record<string, unknown> {
  const members = member ? new Map([[USER_ID, member]]) : new Map();

  return {
    id: guildId,
    members: {
      cache: members,
      fetch: vi.fn(async (id: string) => {
        const found = members.get(id);

        if (!found) throw new Error(`no member ${id}`);

        return found;
      }),
    },
  };
}

/** What a fake interaction can be told. */
interface FakeOptions {
  /** The guild the interaction comes from. */
  readonly guildId?: string;
  /** The member who presses the button. */
  readonly member?: FakeMember | null;
}

/** A button press. */
function buttonInteraction(
  options: FakeOptions = {},
): ButtonInteraction & { reply: ReturnType<typeof vi.fn> } {
  const guildId = options.guildId ?? GUILD_ID;
  const member = options.member === undefined ? MODERATOR : options.member;

  return {
    guildId,
    guild: fakeGuild(guildId, member),
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & { reply: ReturnType<typeof vi.fn> };
}

/**
 * A select-menu press.
 *
 * Only the parts the panel touches are here: the picked value, the guild
 * and the two ways the panel can answer.
 */
function selectInteraction(
  value: string,
  options: FakeOptions = {},
): AnySelectMenuInteraction & {
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const guildId = options.guildId ?? GUILD_ID;
  const member = options.member === undefined ? MODERATOR : options.member;

  return {
    guildId,
    guild: fakeGuild(guildId, member),
    user: { id: USER_ID },
    values: [value],
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnySelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

/**
 * A modal submit.
 */
function modalInteraction(
  value: string,
  options: FakeOptions = {},
): ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> } {
  const guildId = options.guildId ?? GUILD_ID;
  const member = options.member === undefined ? MODERATOR : options.member;

  return {
    guildId,
    guild: fakeGuild(guildId, member),
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: () => value,
    },
    message: null,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModalSubmitInteraction & {
    reply: ReturnType<typeof vi.fn>;
  };
}

/* ------------------------------------------------------------------ *
 * The ids of the panel
 * ------------------------------------------------------------------ */

/**
 * The id of something on the **list panel**.
 */
function listId(action: SsModListAction, target?: string): SsModId {
  return { surface: SSMOD_SURFACES.list, action, target: target ?? null };
}

/**
 * The id of something on the **editor**.
 */
function editorId(action: SsModEditAction, target?: string): SsModId {
  return { surface: SSMOD_SURFACES.edit, action, target: target ?? null };
}

/**
 * The id of something on the **wizard**.
 */
function wizardId(action: SsModWizardAction, target?: string): SsModId {
  return { surface: SSMOD_SURFACES.wizard, action, target: target ?? null };
}

/* ------------------------------------------------------------------ *
 * The setup
 * ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();

  table.clear();

  mocks.service.assertSsConfigAllowance.mockResolvedValue(undefined);
  mocks.service.assertScreenshotTypeAllowed.mockResolvedValue(undefined);
  mocks.service.assertSuccessMessageAllowed.mockResolvedValue(undefined);
  mocks.service.updateSsConfig.mockResolvedValue(undefined);
  mocks.service.deleteSsConfig.mockResolvedValue(undefined);
  mocks.service.createSsConfig.mockResolvedValue(undefined);

  // The faked service is a table keyed by the guild **and** the row id,
  // the way the repository is.
  mocks.service.findSsConfig.mockImplementation(
    async (guildId: string, id: string) => table.get(key(guildId, id)) ?? null,
  );

  mocks.service.updateSsConfig.mockImplementation(
    async (guildId: string, id: string, patch: Record<string, unknown>) => {
      const row = table.get(key(guildId, id));

      if (!row) return;

      table.set(key(guildId, id), { ...row, ...patch });
    },
  );

  mocks.service.deleteSsConfig.mockImplementation(
    async (guildId: string, id: string) => {
      table.delete(key(guildId, id));
    },
  );

  mocks.service.createSsConfig.mockImplementation(
    async (input: { guildId: string }) => {
      const created = makeSetup(input.guildId, "config-new");

      table.set(key(input.guildId, "config-new"), created);

      return created;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * The authorisation
 * ------------------------------------------------------------------ */

describe("the panel's authorisation", () => {
  it("refuses an ordinary member who clicks delete, and the row is still there", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
    expect(mocks.service.deleteSsConfig).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who picks a channel, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    const interaction = selectInteraction("channel-9", {
      member: ORDINARY_MEMBER,
    });

    await ssmod.handleSsModSelect(
      interaction,
      editorId(SSMOD_ACTIONS.setChannel, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.channelId).toBe("channel-1");
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who picks a role, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("role-9", { member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.setRole, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.roleId).toBe("role-1");
  });

  it("refuses an ordinary member who picks a type, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("instagram", { member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.setType, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.ssType).toBe("youtube");
  });

  it("refuses an ordinary member who picks a count, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("5", { member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.setCount, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.requiredSs).toBe(2);
  });

  it("refuses an ordinary member who submits the page-details modal, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Team Nova", { member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.pageDetails, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.channelName).toBe("Team Phoenix");
  });

  it("refuses an ordinary member who submits the success-message modal, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Well done", { member: ORDINARY_MEMBER }),
      editorId(SSMOD_ACTIONS.successMessage, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBeNull();
  });

  it("refuses an ordinary member who opens the editor, and the setup is not read", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    const interaction = buttonInteraction({ member: ORDINARY_MEMBER });

    await ssmod.handleSsModButton(
      interaction,
      listId(SSMOD_ACTIONS.edit, "config-1"),
    );

    expect(mocks.service.findSsConfig).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who starts a setup, and nothing is created", async () => {
    await ssmod.handleSsModButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      listId(SSMOD_ACTIONS.setup),
    );

    expect(mocks.service.createSsConfig).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who saves the wizard, and nothing is created", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    ssmod.writeSsDraft(token, {
      ...ssmod.emptySsDraft(),
      channelId: "channel-1",
      roleId: "role-1",
      requiredSs: 2,
      ssType: "youtube",
      channelName: "Team Phoenix",
    });

    await ssmod.handleSsModButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      wizardId(SSMOD_ACTIONS.save, token),
    );

    expect(mocks.service.createSsConfig).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who drives the wizard's select menu", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModSelect(
      selectInteraction("channel-9", { member: ORDINARY_MEMBER }),
      wizardId(SSMOD_ACTIONS.setChannel, token),
    );

    expect(ssmod.readSsDraft(token)?.channelId).toBeNull();
  });

  it("refuses an ordinary member who drives the wizard's modal", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModModal(
      modalInteraction("Well done", { member: ORDINARY_MEMBER }),
      wizardId(SSMOD_ACTIONS.successMessage, token),
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBeNull();
  });

  it("refuses a member who is not in the guild at all", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: null }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
  });

  it("lets a moderator of the same guild delete the setup", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: MODERATOR }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeUndefined();
    expect(mocks.service.deleteSsConfig).toHaveBeenCalledWith(
      GUILD_ID,
      "config-1",
    );
  });

  it("lets an administrator of the same guild delete the setup", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: ADMINISTRATOR }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeUndefined();
  });

  it("lets a moderator of the same guild repoint the channel", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("channel-9", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.setChannel, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.channelId).toBe("channel-9");
  });

  it("lets a moderator of the same guild change the role", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("role-9", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.setRole, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.roleId).toBe("role-9");
  });

  it("lets a moderator of the same guild change the type", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("instagram", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.setType, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.ssType).toBe("instagram");
  });

  it("lets a moderator of the same guild change the count", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("5", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.setCount, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.requiredSs).toBe(5);
  });

  it("lets a moderator of the same guild set the page details", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Team Nova", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.pageDetails, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.channelName).toBe("Team Nova");
  });

  it("lets a moderator of the same guild set the success message", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Well done", { member: MODERATOR }),
      editorId(SSMOD_ACTIONS.successMessage, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBe("Well done");
  });

  it("refuses a moderator of another guild, and the setup is still there", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ guildId: OTHER_GUILD_ID, member: MODERATOR }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
    expect(mocks.service.deleteSsConfig).not.toHaveBeenCalled();
  });

  it("looks a setup up in the caller's guild, so another guild's row is not found", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));
    table.set(key(OTHER_GUILD_ID, "config-2"), makeSetup(OTHER_GUILD_ID, "config-2"));

    await ssmod.handleSsModButton(
      buttonInteraction({ guildId: OTHER_GUILD_ID, member: MODERATOR }),
      editorId(SSMOD_ACTIONS.delete, "config-1"),
    );

    // The row of the other guild is untouched, and the row id of the first
    // guild was looked up in the second guild — where it does not exist.
    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
    expect(table.get(key(OTHER_GUILD_ID, "config-2"))).toBeDefined();
    expect(mocks.service.findSsConfig).toHaveBeenCalledWith(
      OTHER_GUILD_ID,
      "config-1",
    );
  });

  it("does not let a moderator of another guild reach this guild's setup by id", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    const interaction = selectInteraction("channel-9", {
      guildId: OTHER_GUILD_ID,
      member: MODERATOR,
    });

    await ssmod.handleSsModSelect(
      interaction,
      editorId(SSMOD_ACTIONS.setChannel, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.channelId).toBe("channel-1");
  });

  it("does not let a moderator of another guild reach this guild's setup by modal", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Well done", {
        guildId: OTHER_GUILD_ID,
        member: MODERATOR,
      }),
      editorId(SSMOD_ACTIONS.successMessage, "config-1"),
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBeNull();
  });

  it("does not let a moderator of another guild drive this guild's wizard", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModSelect(
      selectInteraction("channel-9", {
        guildId: OTHER_GUILD_ID,
        member: MODERATOR,
      }),
      wizardId(SSMOD_ACTIONS.setChannel, token),
    );

    expect(ssmod.readSsDraft(token)?.channelId).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The screenshot-type gate
 * ------------------------------------------------------------------ */

describe("the screenshot-type gate", () => {
  it("asks for the entitlement before the type is chosen", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModSelect(
      selectInteraction("instagram"),
      wizardId(SSMOD_ACTIONS.setType, token),
    );

    expect(mocks.service.assertScreenshotTypeAllowed).toHaveBeenCalledWith(
      GUILD_ID,
      "instagram",
    );
  });

  it("leaves the draft alone when the entitlement is refused", async () => {
    // The bug: the type was written to the draft first, and the check
    // came second. A refused type must not survive in the draft.
    mocks.service.assertScreenshotTypeAllowed.mockImplementation(() => {
      throw new PremiumRequiredError(
        PremiumFeature.screenshotTypes,
        "This feature needs a premium entitlement.",
      );
    });

    const token = ssmod.startSsWizard(GUILD_ID);

    const interaction = selectInteraction("instagram");

    await ssmod.handleSsModSelect(
      interaction,
      wizardId(SSMOD_ACTIONS.setType, token),
    );

    expect(ssmod.readSsDraft(token)?.ssType).toBeNull();
  });

  it("does not re-render the panel when the type was refused", async () => {
    mocks.service.assertScreenshotTypeAllowed.mockImplementation(() => {
      throw new PremiumRequiredError(
        PremiumFeature.screenshotTypes,
        "This feature needs a premium entitlement.",
      );
    });

    const token = ssmod.startSsWizard(GUILD_ID);

    const interaction = selectInteraction("instagram");

    await ssmod.handleSsModSelect(
      interaction,
      wizardId(SSMOD_ACTIONS.setType, token),
    );

    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("keeps the type when the entitlement is there", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModSelect(
      selectInteraction("instagram"),
      wizardId(SSMOD_ACTIONS.setType, token),
    );

    expect(ssmod.readSsDraft(token)?.ssType).toBe("instagram");
  });
});

/* ------------------------------------------------------------------ *
 * The success-message gate
 * ------------------------------------------------------------------ */

describe("the success-message gate", () => {
  it("asks for the entitlement before the message is set", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModModal(
      modalInteraction("Well done"),
      wizardId(SSMOD_ACTIONS.successMessage, token),
    );

    expect(mocks.service.assertSuccessMessageAllowed).toHaveBeenCalledWith(
      GUILD_ID,
    );
  });

  it("leaves the draft alone when the entitlement is refused", async () => {
    mocks.service.assertSuccessMessageAllowed.mockImplementation(() => {
      throw new PremiumRequiredError(
        PremiumFeature.successMessage,
        "This feature needs a premium entitlement.",
      );
    });

    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModModal(
      modalInteraction("Well done"),
      wizardId(SSMOD_ACTIONS.successMessage, token),
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBeNull();
  });

  it("keeps the message when the entitlement is there", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsModModal(
      modalInteraction("Well done"),
      wizardId(SSMOD_ACTIONS.successMessage, token),
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBe("Well done");
  });
});

/* ------------------------------------------------------------------ *
 * The wizard's draft
 * ------------------------------------------------------------------ */

describe("the wizard's draft", () => {
  it("is not complete until everything is filled in", () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    expect(ssmod.isDraftComplete(ssmod.readSsDraft(token) ?? ssmod.emptySsDraft())).toBe(
      false,
    );
  });

  it("is complete once the channel, the role, the count, the type and the page are set", () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    ssmod.writeSsDraft(token, {
      ...ssmod.emptySsDraft(),
      channelId: "channel-1",
      roleId: "role-1",
      requiredSs: 2,
      ssType: "youtube",
      channelName: "Team Phoenix",
    });

    expect(
      ssmod.isDraftComplete(ssmod.readSsDraft(token) ?? ssmod.emptySsDraft()),
    ).toBe(true);
  });

  it("remembers the guild it was started in", () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    expect(ssmod.readSsWizard(token)?.guildId).toBe(GUILD_ID);
  });
});

/* ------------------------------------------------------------------ *
 * The custom ids
 * ------------------------------------------------------------------ */

/** Every custom id of a panel. */
function customIds(panel: { components: unknown }): string[] {
  const rows = panel.components as {
    toJSON(): { components?: { custom_id?: string }[] };
  }[];

  return rows.flatMap((row) =>
    (row.toJSON().components ?? [])
      .map((component) => component.custom_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

describe("the custom ids", () => {
  it("gives every surface its own segment", () => {
    const list = customIds(ssmod.buildSsListPanel([makeSetup(GUILD_ID, "config-1")]));

    expect(list.length).toBeGreaterThan(0);
    expect(list.every((id) => id.startsWith("identity:ssmod:list:"))).toBe(true);
  });

  it("gives the wizard's own buttons the wizard's surface", () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    const panel = ssmod.buildSsPanel({
      kind: "setup",
      token,
      draft: ssmod.emptySsDraft(),
    });

    const ids = customIds(panel);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("identity:ssmod:wizard:"))).toBe(true);
  });

  it("gives the editor's buttons the editor's surface", () => {
    const panel = ssmod.buildSsPanel({
      kind: "edit",
      configId: "config-1",
      config: makeSetup(GUILD_ID, "config-1"),
    });

    const ids = customIds(panel);

    expect(ids).toContain("identity:ssmod:edit:delete:config-1");
    expect(ids.every((id) => id.startsWith("identity:ssmod:edit:"))).toBe(true);
  });

  it("keeps the list panel's setup button out of the wizard's surface", () => {
    const panel = ssmod.buildSsListPanel([makeSetup(GUILD_ID, "config-1")]);

    const ids = customIds(panel);

    expect(ids).toContain("identity:ssmod:list:setup");
    expect(
      ids.some((id) => id.startsWith("identity:ssmod:wizard:")),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The routing
 * ------------------------------------------------------------------ */

/** A button press on a custom id, through the real router. */
function routedButton(customId: string): ButtonInteraction & {
  update: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    customId,
    guildId: GUILD_ID,
    guild: fakeGuild(GUILD_ID, MODERATOR),
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    update: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

/** A select-menu press on a custom id, through the real router. */
function routedSelect(
  customId: string,
  value: string,
): AnySelectMenuInteraction & {
  update: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    customId,
    guildId: GUILD_ID,
    guild: fakeGuild(GUILD_ID, MODERATOR),
    user: { id: USER_ID },
    values: [value],
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => true,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnySelectMenuInteraction & {
    update: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

/** A modal submit on a custom id, through the real router. */
function routedModal(
  customId: string,
  value: string,
): ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> } {
  return {
    customId,
    guildId: GUILD_ID,
    guild: fakeGuild(GUILD_ID, MODERATOR),
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => value },
    message: null,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
}

/**
 * Registers the area with the router.
 */
function registerArea(): void {
  interactions.registerIdentityInteractions({
    registerButton: router.registerButton,
    registerSelect: router.registerSelect,
    registerModal: router.registerModal,
  });
}

/**
 * The id in the list that starts with the prefix.
 */
function idOf(ids: readonly string[], prefix: string): string {
  const found = ids.find((id) => id.startsWith(prefix));

  if (!found) throw new Error(`no id starts with "${prefix}"`);

  return found;
}

/** What the record says when a press was not answered. */
const NOT_ANSWERED = "NOT ANSWERED";

/**
 * Presses every id the panel builds and records what each press did.
 *
 * The record is the **effect** of the press — a row written, a row
 * deleted, a wizard opened — so it says which handler answered, and not
 * merely that something answered.
 */
async function pressEveryId(): Promise<string[]> {
  const record: string[] = [];

  // The setup the list panel's Edit button opens.
  table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

  // --- the list panel ---
  const listIds = customIds(
    ssmod.buildSsListPanel([makeSetup(GUILD_ID, "config-1")]),
  );

  const setup = routedButton(idOf(listIds, "identity:ssmod:list:setup"));

  await router.dispatch(setup);

  record.push(
    `list:setup → ${
      mocks.service.assertSsConfigAllowance.mock.calls.length > 0
        ? "the wizard opened"
        : NOT_ANSWERED
    }`,
  );

  const faq = routedButton(idOf(listIds, "identity:ssmod:list:faq"));

  await router.dispatch(faq);

  record.push(
    `list:faq → ${faq.reply.mock.calls.length > 0 ? "the FAQ was sent" : NOT_ANSWERED}`,
  );

  const edit = routedButton(idOf(listIds, "identity:ssmod:list:edit:"));

  await router.dispatch(edit);

  record.push(
    `list:edit → ${edit.update.mock.calls.length > 0 ? "the editor opened" : NOT_ANSWERED}`,
  );

  // --- the wizard ---
  const token = ssmod.startSsWizard(GUILD_ID);

  const draft: SsDraft = {
    ...ssmod.emptySsDraft(),
    channelId: "channel-1",
    roleId: "role-1",
    requiredSs: 2,
    ssType: "youtube",
    channelName: "Team Phoenix",
  };

  ssmod.writeSsDraft(token, draft);

  const wizardIds = customIds(ssmod.buildSsPanel({ kind: "setup", token, draft }));

  const channel = routedSelect(
    idOf(wizardIds, "identity:ssmod:wizard:set_channel:"),
    "channel-9",
  );

  await router.dispatch(channel);

  record.push(
    `wizard:set_channel → ${
      ssmod.readSsDraft(token)?.channelId === "channel-9"
        ? "the draft was written"
        : NOT_ANSWERED
    }`,
  );

  const save = routedButton(idOf(wizardIds, "identity:ssmod:wizard:save:"));

  await router.dispatch(save);

  record.push(
    `wizard:save → ${
      mocks.service.createSsConfig.mock.calls.length > 0
        ? "the setup was created"
        : NOT_ANSWERED
    }`,
  );

  // A second wizard, so the cancel is not answered by the save's
  // teardown.
  const other = ssmod.startSsWizard(GUILD_ID);

  const otherIds = customIds(
    ssmod.buildSsPanel({
      kind: "setup",
      token: other,
      draft: ssmod.emptySsDraft(),
    }),
  );

  const cancel = routedButton(idOf(otherIds, "identity:ssmod:wizard:close:"));

  await router.dispatch(cancel);

  record.push(
    `wizard:close → ${
      ssmod.readSsDraft(other) === undefined
        ? "the draft was dropped"
        : NOT_ANSWERED
    }`,
  );

  // --- the editor ---
  const editorIds = customIds(
    ssmod.buildSsPanel({
      kind: "edit",
      configId: "config-1",
      config: makeSetup(GUILD_ID, "config-1"),
    }),
  );

  const role = routedSelect(
    idOf(editorIds, "identity:ssmod:edit:set_role:"),
    "role-9",
  );

  await router.dispatch(role);

  record.push(
    `edit:set_role → ${
      table.get(key(GUILD_ID, "config-1"))?.roleId === "role-9"
        ? "the row was written"
        : NOT_ANSWERED
    }`,
  );

  const details = routedModal(
    idOf(editorIds, "identity:ssmod:edit:page_details:"),
    "Team Nova",
  );

  await router.dispatch(details);

  record.push(
    `edit:page_details → ${
      table.get(key(GUILD_ID, "config-1"))?.channelName === "Team Nova"
        ? "the row was written"
        : NOT_ANSWERED
    }`,
  );

  const del = routedButton(idOf(editorIds, "identity:ssmod:edit:delete:"));

  await router.dispatch(del);

  record.push(
    `edit:delete → ${
      table.get(key(GUILD_ID, "config-1")) === undefined
        ? "the row was deleted"
        : NOT_ANSWERED
    }`,
  );

  return record;
}

/**
 * Registers the prefixes in the given order and presses every id.
 *
 * The order is the point: the area's prefix has to answer its own ids
 * whether it is registered first or last.
 */
async function pressEveryIdInOrder(
  order: readonly string[],
): Promise<string[]> {
  router.clearRegistry();

  // The mocks count the calls of the press, so they start empty.
  vi.clearAllMocks();

  table.clear();

  for (const prefix of order) {
    if (prefix === SSMOD_PREFIX) {
      registerArea();
      continue;
    }

    // Another area's prefix. It owns nothing of this area's ids, and
    // the order it is registered in must not change that.
    router.registerButton(prefix, () => {});
    router.registerSelect(prefix, () => {});
    router.registerModal(prefix, () => {});
  }

  return pressEveryId();
}

describe("the area's registration", () => {
  it("registers one prefix per kind of component", () => {
    router.clearRegistry();

    registerArea();

    const prefixes = router.registeredPrefixes();

    expect(prefixes.buttons).toEqual([SSMOD_PREFIX]);
    expect(prefixes.selects).toEqual([SSMOD_PREFIX]);
    expect(prefixes.modals).toEqual([SSMOD_PREFIX]);
  });

  it("does not make the router warn about shadowing", () => {
    const warnings: string[] = [];

    const spy = vi
      .spyOn(logger, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      });

    try {
      router.clearRegistry();

      registerArea();
    } finally {
      spy.mockRestore();
    }

    expect(warnings).toEqual([]);
  });

  it("answers every id the same way in either registration order", async () => {
    const first = await pressEveryIdInOrder([
      "identity:tagcheck",
      SSMOD_PREFIX,
    ]);

    const second = await pressEveryIdInOrder([
      SSMOD_PREFIX,
      "identity:tagcheck",
    ]);

    // The same handler answers in both orders.
    expect(second).toEqual(first);

    // And every id of the area reached one.
    expect(first.filter((line) => line.includes(NOT_ANSWERED))).toEqual([]);
  });
});
