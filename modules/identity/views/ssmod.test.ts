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
 * The service is faked with a table that is keyed by the guild *and* the
 * row id, the way the repository is, so the assertions are about the
 * **state** — "the row is still there" — and not about the calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { PremiumRequiredError } from "../../../core/errors.js";
import { PremiumFeature } from "../../../core/constants.js";
import type { SsConfig } from "../types.js";
import type { SsDraft } from "./ssmod.js";

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

/* ------------------------------------------------------------------ *
 * The authorisation
 * ------------------------------------------------------------------ */

describe("the panel's authorisation", () => {
  it("refuses an ordinary member who clicks delete, and the row is still there", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      "delete:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
    expect(mocks.service.deleteSsConfig).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who picks a channel, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    const interaction = selectInteraction("channel-9", {
      member: ORDINARY_MEMBER,
    });

    await ssmod.handleSsModSelect(interaction, "set_channel:config-1");

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.channelId).toBe("channel-1");
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who picks a role, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("role-9", { member: ORDINARY_MEMBER }),
      "set_role:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.roleId).toBe("role-1");
  });

  it("refuses an ordinary member who picks a type, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("instagram", { member: ORDINARY_MEMBER }),
      "set_type:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.ssType).toBe("youtube");
  });

  it("refuses an ordinary member who picks a count, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("5", { member: ORDINARY_MEMBER }),
      "set_count:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.requiredSs).toBe(2);
  });

  it("refuses an ordinary member who submits the page-details modal, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Team Nova", { member: ORDINARY_MEMBER }),
      "page_details:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.channelName).toBe("Team Phoenix");
  });

  it("refuses an ordinary member who submits the success-message modal, and nothing is written", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Well done", { member: ORDINARY_MEMBER }),
      "success_message:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBeNull();
  });

  it("refuses an ordinary member who opens the editor, and the setup is not read", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    const interaction = buttonInteraction({ member: ORDINARY_MEMBER });

    await ssmod.handleSsModButton(interaction, "edit:config-1");

    expect(mocks.service.findSsConfig).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who starts a setup, and nothing is created", async () => {
    await ssmod.handleSsModButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      "setup",
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

    await ssmod.handleSsSetupButton(
      buttonInteraction({ member: ORDINARY_MEMBER }),
      `save:${token}`,
    );

    expect(mocks.service.createSsConfig).not.toHaveBeenCalled();
  });

  it("refuses an ordinary member who drives the wizard's select menu", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsSetupSelect(
      selectInteraction("channel-9", { member: ORDINARY_MEMBER }),
      `set_channel:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.channelId).toBeNull();
  });

  it("refuses an ordinary member who drives the wizard's modal", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done", { member: ORDINARY_MEMBER }),
      `success_message:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBeNull();
  });

  it("refuses a member who is not in the guild at all", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: null }),
      "delete:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
  });

  it("lets a moderator of the same guild delete the setup", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ member: MODERATOR }),
      "delete:config-1",
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
      "delete:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeUndefined();
  });

  it("lets a moderator of the same guild repoint the channel", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("channel-9", { member: MODERATOR }),
      "set_channel:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.channelId).toBe("channel-9");
  });

  it("lets a moderator of the same guild change the role", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("role-9", { member: MODERATOR }),
      "set_role:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.roleId).toBe("role-9");
  });

  it("lets a moderator of the same guild change the type", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("instagram", { member: MODERATOR }),
      "set_type:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.ssType).toBe("instagram");
  });

  it("lets a moderator of the same guild change the count", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModSelect(
      selectInteraction("5", { member: MODERATOR }),
      "set_count:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.requiredSs).toBe(5);
  });

  it("lets a moderator of the same guild set the page details", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Team Nova", { member: MODERATOR }),
      "page_details:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.channelName).toBe("Team Nova");
  });

  it("lets a moderator of the same guild set the success message", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModModal(
      modalInteraction("Well done", { member: MODERATOR }),
      "success_message:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBe("Well done");
  });

  it("refuses a moderator of another guild, and the setup is still there", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));

    await ssmod.handleSsModButton(
      buttonInteraction({ guildId: OTHER_GUILD_ID, member: MODERATOR }),
      "delete:config-1",
    );

    expect(table.get(key(GUILD_ID, "config-1"))).toBeDefined();
    expect(mocks.service.deleteSsConfig).not.toHaveBeenCalled();
  });

  it("looks a setup up in the caller's guild, so another guild's row is not found", async () => {
    table.set(key(GUILD_ID, "config-1"), makeSetup(GUILD_ID, "config-1"));
    table.set(key(OTHER_GUILD_ID, "config-2"), makeSetup(OTHER_GUILD_ID, "config-2"));

    await ssmod.handleSsModButton(
      buttonInteraction({ guildId: OTHER_GUILD_ID, member: MODERATOR }),
      "delete:config-1",
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

    await ssmod.handleSsModSelect(interaction, "set_channel:config-1");

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
      "success_message:config-1",
    );

    expect(mocks.service.updateSsConfig).not.toHaveBeenCalled();
    expect(table.get(key(GUILD_ID, "config-1"))?.successMessage).toBeNull();
  });

  it("does not let a moderator of another guild drive this guild's wizard", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsSetupSelect(
      selectInteraction("channel-9", {
        guildId: OTHER_GUILD_ID,
        member: MODERATOR,
      }),
      `set_channel:${token}`,
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

    await ssmod.handleSsSetupSelect(
      selectInteraction("instagram"),
      `set_type:${token}`,
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

    await ssmod.handleSsSetupSelect(interaction, `set_type:${token}`);

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

    await ssmod.handleSsSetupSelect(interaction, `set_type:${token}`);

    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("keeps the type when the entitlement is there", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsSetupSelect(
      selectInteraction("instagram"),
      `set_type:${token}`,
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

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
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

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBeNull();
  });

  it("keeps the message when the entitlement is there", async () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
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

/**
 * Does a prefix own a custom id?
 *
 * The router's own rule: the prefix has to end on a segment boundary.
 */
function prefixMatches(prefix: string, customId: string): boolean {
  return customId === prefix || customId.startsWith(`${prefix}:`);
}

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
  it("keeps the list panel's setup button out of the wizard's prefix", () => {
    const panel = ssmod.buildSsListPanel([makeSetup(GUILD_ID, "config-1")]);

    const ids = customIds(panel);

    expect(ids).toContain("identity:ssmod:setup");
    expect(
      ids.some((id) => prefixMatches(ssmod.SSMOD_WIZARD_PREFIX, id)),
    ).toBe(false);
  });

  it("gives the wizard's own buttons the wizard's prefix", () => {
    const token = ssmod.startSsWizard(GUILD_ID);

    const panel = ssmod.buildSsPanel({
      kind: "setup",
      token,
      draft: ssmod.emptySsDraft(),
    });

    const ids = customIds(panel);

    expect(ids.length).toBeGreaterThan(0);
    expect(
      ids.every((id) => prefixMatches(ssmod.SSMOD_WIZARD_PREFIX, id)),
    ).toBe(true);
  });

  it("gives the editor's buttons the editor's prefix", () => {
    const panel = ssmod.buildSsPanel({
      kind: "edit",
      configId: "config-1",
      config: makeSetup(GUILD_ID, "config-1"),
    });

    const ids = customIds(panel);

    expect(ids).toContain("identity:ssmod:delete:config-1");
    expect(
      ids.some((id) => prefixMatches(ssmod.SSMOD_WIZARD_PREFIX, id)),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The routing
 * ------------------------------------------------------------------ */

/**
 * A button press on a custom id.
 */
function routedButton(customId: string): ButtonInteraction {
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
  } as unknown as ButtonInteraction;
}

describe("the routing of the panel's buttons", () => {
  beforeEach(async () => {
    const router = await import("../../../core/router.js");
    const interactions = await import("../interactions.js");

    router.clearRegistry();

    interactions.registerIdentityInteractions({
      registerButton: router.registerButton,
      registerSelect: router.registerSelect,
      registerModal: router.registerModal,
    });
  });

  it("sends the list panel's setup button to the handler that opens a wizard", async () => {
    const router = await import("../../../core/router.js");

    const panel = ssmod.buildSsListPanel([]);
    const setupId = customIds(panel).find((id) => id.endsWith(":setup"));

    expect(setupId).toBe("identity:ssmod:setup");

    await router.dispatch(routedButton(setupId ?? ""));

    // The wizard was opened: the allowance was asked for.
    expect(mocks.service.assertSsConfigAllowance).toHaveBeenCalledWith(
      GUILD_ID,
    );
  });

  it("sends the wizard's save button to the handler that saves", async () => {
    const router = await import("../../../core/router.js");

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

    const panel = ssmod.buildSsPanel({ kind: "setup", token, draft });

    const saveId = customIds(panel).find((id) => id.includes(":save:"));

    expect(saveId).toBeDefined();

    await router.dispatch(routedButton(saveId ?? ""));

    expect(mocks.service.createSsConfig).toHaveBeenCalled();
  });
});
