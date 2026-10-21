/**
 * The screenshot-verification panel.
 *
 * The panel's premium gates are the interesting part: the entitlement is
 * checked **before** the draft or the row is changed, so a refused
 * configuration is never persisted. Quotient assigned the screenshot type
 * to the record first and checked afterwards, and the editor then wrote
 * every field of the record on the next interaction — so a free guild
 * ended up with a premium type (B8). The success message had no gate in
 * the wizard at all (B12).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnySelectMenuInteraction, ModalSubmitInteraction } from "discord.js";
import { PremiumRequiredError } from "../../../core/errors.js";
import { PremiumFeature } from "../../../core/constants.js";

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

/**
 * A select-menu interaction.
 *
 * Only the parts the panel touches are here: the picked value, the guild
 * and the two ways the panel can answer.
 */
function selectInteraction(
  value: string,
): AnySelectMenuInteraction & {
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  return {
    guildId: "guild-1",
    values: [value],
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
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
): ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> } {
  return {
    guildId: "guild-1",
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: () => value,
    },
    message: null,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModalSubmitInteraction & {
    reply: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.service.assertSsConfigAllowance.mockResolvedValue(undefined);
  mocks.service.assertScreenshotTypeAllowed.mockResolvedValue(undefined);
  mocks.service.assertSuccessMessageAllowed.mockResolvedValue(undefined);
  mocks.service.updateSsConfig.mockResolvedValue(undefined);
});

describe("the screenshot-type gate", () => {
  it("asks for the entitlement before the type is chosen", async () => {
    const token = ssmod.startSsWizard();

    await ssmod.handleSsSetupSelect(
      selectInteraction("instagram"),
      `set_type:${token}`,
    );

    expect(mocks.service.assertScreenshotTypeAllowed).toHaveBeenCalledWith(
      "guild-1",
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

    const token = ssmod.startSsWizard();

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

    const token = ssmod.startSsWizard();

    const interaction = selectInteraction("instagram");

    await ssmod.handleSsSetupSelect(interaction, `set_type:${token}`);

    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("keeps the type when the entitlement is there", async () => {
    const token = ssmod.startSsWizard();

    await ssmod.handleSsSetupSelect(
      selectInteraction("instagram"),
      `set_type:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.ssType).toBe("instagram");
  });
});

describe("the success-message gate", () => {
  it("asks for the entitlement before the message is set", async () => {
    const token = ssmod.startSsWizard();

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
    );

    expect(mocks.service.assertSuccessMessageAllowed).toHaveBeenCalledWith(
      "guild-1",
    );
  });

  it("leaves the draft alone when the entitlement is refused", async () => {
    mocks.service.assertSuccessMessageAllowed.mockImplementation(() => {
      throw new PremiumRequiredError(
        PremiumFeature.successMessage,
        "This feature needs a premium entitlement.",
      );
    });

    const token = ssmod.startSsWizard();

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBeNull();
  });

  it("keeps the message when the entitlement is there", async () => {
    const token = ssmod.startSsWizard();

    await ssmod.handleSsSetupModal(
      modalInteraction("Well done"),
      `success_message:${token}`,
    );

    expect(ssmod.readSsDraft(token)?.successMessage).toBe("Well done");
  });
});

describe("the wizard's draft", () => {
  it("is not complete until everything is filled in", () => {
    const token = ssmod.startSsWizard();

    expect(ssmod.isDraftComplete(ssmod.readSsDraft(token) ?? ssmod.emptySsDraft())).toBe(
      false,
    );
  });

  it("is complete once the channel, the role, the count, the type and the page are set", () => {
    const token = ssmod.startSsWizard();

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
});
