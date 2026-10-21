/**
 * The service: the premium gates and the rate limits.
 *
 * The gates are the interesting part. Every one of them has to run
 * **before** the state it guards changes — a refusal that arrives after
 * the state changed cannot be undone, and Quotient's two live premium
 * leaks were exactly that: the screenshot type was written to a free
 * guild's row before the entitlement was checked (B8), and the success
 * message had no gate in the wizard at all (B12).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PremiumRequiredError } from "../../core/errors.js";
import { PremiumFeature } from "../../core/constants.js";

const mocks = vi.hoisted(() => ({
  repo: {
    countTagCheckChannels: vi.fn(),
    countEasyTagChannels: vi.fn(),
    countSsConfigs: vi.fn(),
    insertTagCheckChannel: vi.fn(),
    insertEasyTagChannel: vi.fn(),
    insertSsConfig: vi.fn(),
    findTagCheckById: vi.fn(),
    findEasyTagByChannel: vi.fn(),
    findSsConfigById: vi.fn(),
    writeTagCheckIgnoreRole: vi.fn(),
    writeEasyTagIgnoreRole: vi.fn(),
  },
  cache: {
    cacheChannel: vi.fn(),
    uncacheChannel: vi.fn(),
  },
  entitlements: {
    assertEntitled: vi.fn(),
  },
}));

vi.mock("./repo.js", () => mocks.repo);
vi.mock("./cache.js", () => mocks.cache);
vi.mock("../premium/entitlements.js", () => mocks.entitlements);

const service = await import("./service.js");

/** The refusal the entitlement helper raises. */
function refuse(feature: string): void {
  mocks.entitlements.assertEntitled.mockImplementation(() => {
    throw new PremiumRequiredError(feature, "This feature needs a premium entitlement.");
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.entitlements.assertEntitled.mockResolvedValue(undefined);
  mocks.repo.insertTagCheckChannel.mockResolvedValue("config-1");
  mocks.repo.insertEasyTagChannel.mockResolvedValue("config-1");
  mocks.repo.insertSsConfig.mockResolvedValue("config-1");
  mocks.repo.findTagCheckById.mockResolvedValue({
    id: "config-1",
    guildId: "guild-1",
    channelId: "channel-1",
    requiredMentions: 4,
    deleteAfter: false,
    ignoreRoleId: "role-1",
  });
  mocks.repo.findEasyTagByChannel.mockResolvedValue({
    id: "config-1",
    guildId: "guild-1",
    channelId: "channel-1",
    deleteAfter: false,
    ignoreRoleId: "role-1",
  });
  mocks.repo.findSsConfigById.mockResolvedValue({
    id: "config-1",
    guildId: "guild-1",
    channelId: "channel-1",
    roleId: "role-1",
    requiredSs: 2,
    channelName: "Team Phoenix",
    channelLink: "",
    keywords: [],
    allowSame: false,
    ssType: "youtube",
    successMessage: null,
  });
});

describe("the tag-check channel gate", () => {
  it("lets the first channel through without asking for an entitlement", async () => {
    mocks.repo.countTagCheckChannels.mockResolvedValue(0);

    await service.setTagCheckChannel({
      guildId: "guild-1",
      channelId: "channel-1",
      requiredMentions: 4,
      ignoreRoleId: "role-1",
    });

    expect(mocks.entitlements.assertEntitled).not.toHaveBeenCalled();
    expect(mocks.repo.insertTagCheckChannel).toHaveBeenCalled();
  });

  it("refuses the second channel of a free guild", async () => {
    mocks.repo.countTagCheckChannels.mockResolvedValue(1);
    refuse(PremiumFeature.extraChannels);

    await expect(
      service.setTagCheckChannel({
        guildId: "guild-1",
        channelId: "channel-2",
        requiredMentions: 4,
        ignoreRoleId: "role-1",
      }),
    ).rejects.toThrow(PremiumRequiredError);
  });

  it("writes nothing when the channel is refused", async () => {
    // The check happens **before** the write, so a refused guild is left
    // exactly as it was.
    mocks.repo.countTagCheckChannels.mockResolvedValue(1);
    refuse(PremiumFeature.extraChannels);

    await expect(
      service.setTagCheckChannel({
        guildId: "guild-1",
        channelId: "channel-2",
        requiredMentions: 4,
        ignoreRoleId: "role-1",
      }),
    ).rejects.toThrow();

    expect(mocks.repo.insertTagCheckChannel).not.toHaveBeenCalled();
    expect(mocks.repo.writeTagCheckIgnoreRole).not.toHaveBeenCalled();
    expect(mocks.cache.cacheChannel).not.toHaveBeenCalled();
  });

  it("asks for the extra-channels entitlement", async () => {
    mocks.repo.countTagCheckChannels.mockResolvedValue(1);
    refuse(PremiumFeature.extraChannels);

    await expect(
      service.setTagCheckChannel({
        guildId: "guild-1",
        channelId: "channel-2",
        requiredMentions: 4,
        ignoreRoleId: "role-1",
      }),
    ).rejects.toThrow();

    expect(mocks.entitlements.assertEntitled).toHaveBeenCalledWith(
      "guild-1",
      PremiumFeature.extraChannels,
    );
  });
});

describe("the easy-tag channel gate", () => {
  it("lets the first channel through", async () => {
    mocks.repo.countEasyTagChannels.mockResolvedValue(0);

    await service.setEasyTagChannel({
      guildId: "guild-1",
      channelId: "channel-1",
      ignoreRoleId: "role-1",
    });

    expect(mocks.entitlements.assertEntitled).not.toHaveBeenCalled();
  });

  it("writes nothing when the channel is refused", async () => {
    mocks.repo.countEasyTagChannels.mockResolvedValue(1);
    refuse(PremiumFeature.extraChannels);

    await expect(
      service.setEasyTagChannel({
        guildId: "guild-1",
        channelId: "channel-2",
        ignoreRoleId: "role-1",
      }),
    ).rejects.toThrow(PremiumRequiredError);

    expect(mocks.repo.insertEasyTagChannel).not.toHaveBeenCalled();
    expect(mocks.cache.cacheChannel).not.toHaveBeenCalled();
  });
});

describe("the screenshot-verification setup gate", () => {
  it("lets the first setup through", async () => {
    mocks.repo.countSsConfigs.mockResolvedValue(0);

    await service.createSsConfig({
      guildId: "guild-1",
      channelId: "channel-1",
      roleId: "role-1",
      requiredSs: 2,
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: [],
      allowSame: false,
      ssType: "youtube",
      successMessage: null,
    });

    expect(mocks.entitlements.assertEntitled).not.toHaveBeenCalled();
  });

  it("writes nothing when the setup is refused", async () => {
    mocks.repo.countSsConfigs.mockResolvedValue(1);
    refuse(PremiumFeature.extraChannels);

    await expect(
      service.createSsConfig({
        guildId: "guild-1",
        channelId: "channel-2",
        roleId: "role-1",
        requiredSs: 2,
        channelName: "Team Phoenix",
        channelLink: "",
        keywords: [],
        allowSame: false,
        ssType: "youtube",
        successMessage: null,
      }),
    ).rejects.toThrow(PremiumRequiredError);

    expect(mocks.repo.insertSsConfig).not.toHaveBeenCalled();
    expect(mocks.cache.cacheChannel).not.toHaveBeenCalled();
  });
});

describe("the screenshot-type gate", () => {
  it("lets the free type through without asking", async () => {
    // YouTube is the only type a free guild may use.
    await service.assertScreenshotTypeAllowed("guild-1", "youtube");

    expect(mocks.entitlements.assertEntitled).not.toHaveBeenCalled();
  });

  it("asks for the screenshot-types entitlement for the others", async () => {
    await service.assertScreenshotTypeAllowed("guild-1", "instagram");

    expect(mocks.entitlements.assertEntitled).toHaveBeenCalledWith(
      "guild-1",
      PremiumFeature.screenshotTypes,
    );
  });

  it("refuses a premium type for a free guild", async () => {
    refuse(PremiumFeature.screenshotTypes);

    await expect(
      service.assertScreenshotTypeAllowed("guild-1", "custom"),
    ).rejects.toThrow(PremiumRequiredError);
  });
});

describe("the success-message gate", () => {
  it("refuses a success message for a free guild", async () => {
    refuse(PremiumFeature.successMessage);

    await expect(service.assertSuccessMessageAllowed("guild-1")).rejects.toThrow(
      PremiumRequiredError,
    );
  });

  it("asks for the success-message entitlement", async () => {
    await service.assertSuccessMessageAllowed("guild-1");

    expect(mocks.entitlements.assertEntitled).toHaveBeenCalledWith(
      "guild-1",
      PremiumFeature.successMessage,
    );
  });
});

describe("the submission rate limits", () => {
  it("is one submission per member every seven seconds", () => {
    expect(service.MEMBER_SUBMISSION_WINDOW_MS).toBe(7_000);

    let now = 1_000_000;

    const limiters = service.createSubmissionLimiters(() => now);

    expect(limiters.member.hit("member-1")).toBeNull();

    // The second one straight away has to wait.
    expect(limiters.member.hit("member-1")).toBe(7_000);

    // A different member is not affected by the first one's hit.
    expect(limiters.member.hit("member-2")).toBeNull();

    now += 7_000;

    expect(limiters.member.hit("member-1")).toBeNull();
  });

  it("is ten submissions per guild every minute", () => {
    expect(service.GUILD_SUBMISSION_WINDOW_MS).toBe(60_000);

    let now = 1_000_000;

    const limiters = service.createSubmissionLimiters(() => now);

    for (let index = 0; index < 10; index += 1) {
      expect(limiters.guild.hit("guild-1")).toBeNull();
    }

    // The eleventh has to wait for the first one to fall out of the
    // window.
    expect(limiters.guild.hit("guild-1")).toBe(60_000);

    // Another guild has its own window.
    expect(limiters.guild.hit("guild-2")).toBeNull();
  });

  it("slides the guild window", () => {
    let now = 1_000_000;

    const limiters = service.createSubmissionLimiters(() => now);

    for (let index = 0; index < 10; index += 1) {
      limiters.guild.hit("guild-1");
    }

    // Half a minute later all ten hits are still inside the sixty second
    // window, and the caller is told how long the first of them has left.
    now += 30_000;

    expect(limiters.guild.hit("guild-1")).toBe(30_000);

    // A refused hit is not recorded, so the window did not slide forward.
    now += 30_001;

    // The first hits have fallen out of the window now.
    expect(limiters.guild.hit("guild-1")).toBeNull();
  });
});
