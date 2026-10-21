import { describe, expect, it } from "vitest";

import {
  defaultCloseMessage,
  defaultOpenMessage,
  defaultSlotlistFormat,
  formatDuration,
  renderCloseMessage,
  renderOpenMessage,
  renderSlotlist,
  slotListLines,
} from "./render.js";
import type { ScrimRecord, SlotRecord } from "./types.js";

function scrim(overrides: Partial<ScrimRecord> = {}): ScrimRecord {
  return {
    id: "scrim-1",
    guildId: "guild-1",
    name: "Friday Scrims",
    status: "open",
    registrationChannelId: "chan-1",
    slotlistChannelId: "chan-2",
    slotlistMessageId: null,
    roleId: "role-1",
    openRoleId: null,
    pingRoleId: null,
    hostId: "user-1",
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
    timeElapsedSeconds: 3725,
    openDays: ["monday"],
    slotlistFormat: {},
    openMessage: {},
    closeMessage: {},
    emojis: { tick: "✅", cross: "❌" },
    cdn: { status: false, countdown: 3, msg: {} },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function slot(num: number, teamName: string | null): SlotRecord {
  return {
    id: `slot-${num}`,
    scrimId: "scrim-1",
    num,
    state: "claimed",
    teamName,
    ownerUserId: "user-1",
    members: ["user-1"],
    messageId: null,
    jumpUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("the duration format", () => {
  it("reads as words", () => {
    expect(formatDuration(3725)).toBe("1 hour, 2 minutes, 5 seconds");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(0)).toBe("0 seconds");
  });

  it("says N/A when there is no duration", () => {
    expect(formatDuration(null)).toBe("N/A");
  });

  it("never goes negative", () => {
    expect(formatDuration(-10)).toBe("0 seconds");
  });
});

describe("the slot lines", () => {
  it("numbers the slots with two digits", () => {
    expect(slotListLines([slot(1, "Team Alpha"), slot(2, "Team Beta")])).toBe(
      "Slot 01  ->  Team Alpha\nSlot 02  ->  Team Beta",
    );
  });

  it("leaves out the slots that are not claimed", () => {
    const free = { ...slot(3, null), state: "free" as const };

    expect(slotListLines([slot(1, "Team Alpha"), free])).toBe(
      "Slot 01  ->  Team Alpha",
    );
  });
});

describe("the open message", () => {
  it("uses the default when nothing was designed", () => {
    const embed = renderOpenMessage(scrim(), {
      mentions: 4,
      totalSlots: 10,
      reservedCount: 2,
      slotlistMention: "<#chan-2>",
      multiregister: false,
      teamnameCompulsion: true,
      bannedMentions: "",
      reservedMentions: "",
    });

    const data = embed.toJSON();

    expect(data.title).toBe("Registration is now open!");
    expect(data.description).toContain("`4`");
    expect(data.description).toContain("`10`");
    expect(data.description).toContain("`2`");
  });

  it("substitutes the keywords of a designed template", () => {
    const embed = renderOpenMessage(
      scrim({
        openMessage: {
          title: "<<teamname>> and <<multireg>>",
          description: "<<mentions>> mentions, <<slots>> slots, <<reserved>> reserved, <<slotlist>>",
        },
      }),
      {
        mentions: 4,
        totalSlots: 10,
        reservedCount: 2,
        slotlistMention: "<#chan-2>",
        multiregister: true,
        teamnameCompulsion: false,
        bannedMentions: "",
        reservedMentions: "",
      },
    );

    const data = embed.toJSON();

    expect(data.title).toBe("No and Enabled");
    expect(data.description).toBe(
      "4 mentions, 10 slots, 2 reserved, <#chan-2>",
    );
  });
});

describe("the close message", () => {
  it("says how many slots were filled", () => {
    const embed = renderCloseMessage(scrim(), {
      totalSlots: 10,
      filled: 7,
      elapsedSeconds: 3725,
      openTime: new Date("2026-03-01T09:00:00.000Z"),
    });

    const data = embed.toJSON();

    expect(data.description).toBe("**Registration is now Closed!**");
  });

  it("substitutes the keywords of a designed template", () => {
    const embed = renderCloseMessage(
      scrim({
        closeMessage: {
          description:
            "<<slots>> slots, <<filled>> filled, taken in <<time_taken>>",
        },
      }),
      {
        totalSlots: 10,
        filled: 7,
        elapsedSeconds: 3725,
        openTime: new Date("2026-03-01T09:00:00.000Z"),
      },
    );

    expect(embed.toJSON().description).toBe(
      "10 slots, 7 filled, taken in 1 hour, 2 minutes, 5 seconds",
    );
  });
});

describe("the slotlist", () => {
  it("uses the default when nothing was designed", () => {
    const embed = renderSlotlist(scrim(), {
      name: "Friday Scrims",
      elapsedSeconds: 3725,
      openTime: new Date("2026-03-01T09:00:00.000Z"),
      slots: "Slot 01  ->  Team Alpha",
    });

    const data = embed.toJSON();

    expect(data.title).toBe("Friday Scrims Slotlist");
    expect(data.description).toContain("Slot 01  ->  Team Alpha");
    expect(data.footer?.text).toBe(
      "Registration took: 1 hour, 2 minutes, 5 seconds",
    );
  });

  it("substitutes the keywords of a designed template", () => {
    const embed = renderSlotlist(
      scrim({
        slotlistFormat: {
          title: "<<name>>",
          description: "<<slots>>",
          footer: { text: "took <<time_taken>>" },
        },
      }),
      {
        name: "Friday Scrims",
        elapsedSeconds: 60,
        openTime: new Date("2026-03-01T09:00:00.000Z"),
        slots: "Slot 01  ->  Team Alpha",
      },
    );

    const data = embed.toJSON();

    expect(data.title).toBe("Friday Scrims");
    expect(data.description).toBe("Slot 01  ->  Team Alpha");
    expect(data.footer?.text).toBe("took 1 minute");
  });
});

describe("the default templates", () => {
  it("carry the keywords the source used", () => {
    expect(defaultOpenMessage().description).toContain("<<mentions>>");
    expect(defaultOpenMessage().description).toContain("<<reserved>>");
    expect(defaultCloseMessage().description).toContain("Closed");
    expect(defaultSlotlistFormat().title).toContain("<<name>>");
  });
});
