/**
 * The slot manager's rules, proved without a database.
 *
 * The properties that matter:
 *
 *  - the claim writes the whole team, not just the claimer (B3);
 *  - a claim that lost the race is refused, not silently accepted;
 *  - cancelling removes the scrim's role only when it was the member's
 *    **last** slot in that scrim;
 *  - the reminder filter excludes **every** match, not every second one
 *    (B2);
 *  - the ID-Pass transfer refuses when no teammate was mentioned.
 */

import { describe, expect, it } from "vitest";

import { makeFakeStore, makeScrim, makeSlot } from "./fake-store.js";
import {
  applyIdpTransfer,
  cancelSlot,
  claimMembers,
  claimSlot,
  claimTeamName,
  filterReminderCandidates,
  idpCandidates,
  isWithinSlotWindow,
  planBan,
  slotNumbersOf,
  startOfDay,
} from "./service.js";
import { BanMode } from "./types.js";
import type { ReminderCandidate } from "./types.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");

describe("the claim", () => {
  it("claims a free slot", async () => {
    const { store, calls } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
    });

    const result = await claimSlot(store, {
      scrimId: "scrim-1",
      num: 3,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "",
      multipleSlots: false,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(calls.claims).toHaveLength(1);
    expect(calls.claims[0]?.num).toBe(3);
  });

  it("refuses a slot somebody else took first", async () => {
    // The conditional UPDATE matched no row: the race was lost.
    const { store } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
      claimResult: null,
    });

    const result = await claimSlot(store, {
      scrimId: "scrim-1",
      num: 3,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "",
      multipleSlots: false,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("taken");
  });

  it("writes the teammate mentions into the member list", async () => {
    // BUG-1 / BUG-3: the source wrote `members=[user_id]` only, so the
    // ID-Pass transfer could never find a teammate.
    const { store, calls } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
    });

    await claimSlot(store, {
      scrimId: "scrim-1",
      num: 1,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "with <@111111111111111111> and <@222222222222222222>",
      multipleSlots: false,
      now: NOW,
    });

    expect(calls.claims[0]?.values.members).toEqual([
      "captain",
      "111111111111111111",
      "222222222222222222",
    ]);
  });

  it("never lists the claimer twice", () => {
    // A mention is a snowflake, so the ids are numbers.
    expect(
      claimMembers("111111111111111111", "<@111111111111111111> <@222222222222222222>"),
    ).toEqual(["111111111111111111", "222222222222222222"]);
  });

  it("refuses a member who is banned from the scrim", async () => {
    const { store, calls } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
      banned: [{ scrimId: "scrim-1", userId: "captain" }],
    });

    const result = await claimSlot(store, {
      scrimId: "scrim-1",
      num: 1,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "",
      multipleSlots: false,
      now: NOW,
    });

    expect(result.ok === false && result.reason).toBe("banned");
    expect(calls.claims).toHaveLength(0);
  });

  it("refuses a second slot when multi-claim is off", async () => {
    const { store, calls } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
      userSlots: [makeSlot({ id: "slot-9", scrimId: "scrim-1" })],
    });

    const result = await claimSlot(store, {
      scrimId: "scrim-1",
      num: 2,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "",
      multipleSlots: false,
      now: NOW,
    });

    expect(result.ok === false && result.reason).toBe("already_holds");
    expect(calls.claims).toHaveLength(0);
  });

  it("allows a second slot when multi-claim is on", async () => {
    const { store, calls } = makeFakeStore({
      scrims: [makeScrim({ id: "scrim-1" })],
      userSlots: [makeSlot({ id: "slot-9", scrimId: "scrim-1" })],
    });

    const result = await claimSlot(store, {
      scrimId: "scrim-1",
      num: 2,
      userId: "captain",
      teamNameInput: "alpha squad",
      mentionText: "",
      multipleSlots: true,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(calls.claims).toHaveLength(1);
  });

  it("normalises the team name the way the source did", () => {
    expect(claimTeamName("team alpha")).toBe("Team Alpha");
    expect(claimTeamName("  ALPHA  ")).toBe("Team Alpha");
    expect(claimTeamName("!!!")).toBe("");
  });
});

describe("the cancel", () => {
  it("removes the role when it was the member's last slot in that scrim", async () => {
    const { store } = makeFakeStore({
      slots: [makeSlot({ id: "slot-1", scrimId: "scrim-1", ownerUserId: "captain" })],
      userSlots: [],
    });

    const result = await cancelSlot(store, {
      slotId: "slot-1",
      userId: "captain",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.roleRemoved).toBe(true);
  });

  it("keeps the role when the member holds another slot in that scrim", async () => {
    const { store } = makeFakeStore({
      slots: [
        makeSlot({ id: "slot-1", scrimId: "scrim-1", ownerUserId: "captain" }),
        makeSlot({ id: "slot-2", scrimId: "scrim-1", ownerUserId: "captain" }),
      ],
      userSlots: [
        makeSlot({ id: "slot-2", scrimId: "scrim-1", ownerUserId: "captain" }),
      ],
    });

    const result = await cancelSlot(store, {
      slotId: "slot-1",
      userId: "captain",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.roleRemoved).toBe(false);
  });

  it("keeps the role when the other slot is in another scrim", async () => {
    // The rule is per scrim: a slot in a different scrim does not count.
    const { store } = makeFakeStore({
      slots: [
        makeSlot({ id: "slot-1", scrimId: "scrim-1", ownerUserId: "captain" }),
        makeSlot({ id: "slot-2", scrimId: "scrim-2", ownerUserId: "captain" }),
      ],
      userSlots: [
        makeSlot({ id: "slot-2", scrimId: "scrim-2", ownerUserId: "captain" }),
      ],
    });

    const result = await cancelSlot(store, {
      slotId: "slot-1",
      userId: "captain",
    });

    expect(result.ok && result.roleRemoved).toBe(true);
  });

  it("refuses to cancel somebody else's slot", async () => {
    const { store, calls } = makeFakeStore({
      slots: [makeSlot({ id: "slot-1", scrimId: "scrim-1", ownerUserId: "captain" })],
    });

    const result = await cancelSlot(store, {
      slotId: "slot-1",
      userId: "somebody-else",
    });

    expect(result.ok === false && result.reason).toBe("not_owner");
    expect(calls.releases).toHaveLength(0);
  });

  it("refuses a slot that does not exist", async () => {
    const { store } = makeFakeStore({ slots: [] });

    const result = await cancelSlot(store, {
      slotId: "nope",
      userId: "captain",
    });

    expect(result.ok === false && result.reason).toBe("not_found");
  });
});

describe("the reminder filter", () => {
  const candidates: ReminderCandidate[] = [
    { scrimId: "scrim-a", scrimName: "A", registrationChannelId: "c-a" },
    { scrimId: "scrim-b", scrimName: "B", registrationChannelId: "c-b" },
    { scrimId: "scrim-c", scrimName: "C", registrationChannelId: "c-c" },
    { scrimId: "scrim-d", scrimName: "D", registrationChannelId: "c-d" },
  ];

  it("excludes a banned scrim", () => {
    const kept = filterReminderCandidates(candidates, {
      bannedScrimIds: ["scrim-a"],
      remindedScrimIds: [],
      ownSlotScrimIds: [],
    });

    expect(kept.map((entry) => entry.scrimId)).toEqual([
      "scrim-b",
      "scrim-c",
      "scrim-d",
    ]);
  });

  it("excludes a scrim the member already has a reminder for", () => {
    const kept = filterReminderCandidates(candidates, {
      bannedScrimIds: [],
      remindedScrimIds: ["scrim-b"],
      ownSlotScrimIds: [],
    });

    expect(kept.map((entry) => entry.scrimId)).toEqual([
      "scrim-a",
      "scrim-c",
      "scrim-d",
    ]);
  });

  it("excludes a scrim the member already holds a slot in", () => {
    const kept = filterReminderCandidates(candidates, {
      bannedScrimIds: [],
      remindedScrimIds: [],
      ownSlotScrimIds: ["scrim-c"],
    });

    expect(kept.map((entry) => entry.scrimId)).toEqual([
      "scrim-a",
      "scrim-b",
      "scrim-d",
    ]);
  });

  it("excludes EVERY match, not every second one", () => {
    // BUG-2: the source removed the matches from the list it was
    // iterating, so every second one survived. Three banned scrims must
    // leave nothing behind.
    const kept = filterReminderCandidates(candidates, {
      bannedScrimIds: ["scrim-a", "scrim-b", "scrim-c"],
      remindedScrimIds: ["scrim-d"],
      ownSlotScrimIds: [],
    });

    expect(kept).toEqual([]);
  });

  it("excludes every match across all three reasons at once", () => {
    const kept = filterReminderCandidates(candidates, {
      bannedScrimIds: ["scrim-a", "scrim-c"],
      remindedScrimIds: ["scrim-b"],
      ownSlotScrimIds: ["scrim-d"],
    });

    expect(kept).toEqual([]);
  });
});

describe("the ID-Pass transfer", () => {
  it("refuses when no teammate was mentioned", async () => {
    // BUG-1: with the source's claim the member list held only the
    // captain, so there was nobody to transfer to and the feature had
    // never worked.
    const { store } = makeFakeStore({
      slots: [
        makeSlot({
          id: "slot-1",
          scrimId: "scrim-1",
          ownerUserId: "captain",
          members: ["captain"],
        }),
      ],
    });

    const result = await idpCandidates(store, {
      slotId: "slot-1",
      userId: "captain",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no_teammate");
  });

  it("offers the teammates that were mentioned", async () => {
    const { store } = makeFakeStore({
      slots: [
        makeSlot({
          id: "slot-1",
          scrimId: "scrim-1",
          ownerUserId: "captain",
          members: ["captain", "teammate"],
        }),
      ],
    });

    const result = await idpCandidates(store, {
      slotId: "slot-1",
      userId: "captain",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.teammates).toEqual(["teammate"]);
  });

  it("writes the new member list back", async () => {
    // BUG-9: the source removed the captain from `slot.members` in
    // memory only, so the database kept listing the old captain.
    const { store, calls } = makeFakeStore({
      slots: [
        makeSlot({
          id: "slot-1",
          scrimId: "scrim-1",
          ownerUserId: "captain",
          members: ["captain", "teammate"],
        }),
      ],
    });

    const result = await applyIdpTransfer(store, {
      slotId: "slot-1",
      newOwnerId: "teammate",
      previousOwnerId: "captain",
    });

    expect(result.ok).toBe(true);
    expect(calls.transfers[0]?.members).toEqual(["teammate"]);
    expect(calls.transfers[0]?.newOwnerId).toBe("teammate");
  });

  it("refuses to transfer a slot the caller does not own", async () => {
    const { store } = makeFakeStore({
      slots: [
        makeSlot({
          id: "slot-1",
          scrimId: "scrim-1",
          ownerUserId: "captain",
          members: ["captain", "teammate"],
        }),
      ],
    });

    const result = await idpCandidates(store, {
      slotId: "slot-1",
      userId: "somebody-else",
    });

    expect(result.ok === false && result.reason).toBe("not_owner");
  });
});

describe("the ban matrix", () => {
  const target = {
    leaderId: "captain",
    memberIds: ["captain", "second", "third"],
  };

  const allScrims = ["scrim-a", "scrim-b"];

  it("mode 1 bans the leader from this scrim", () => {
    const plan = planBan({
      mode: BanMode.leaderThisScrim,
      thisScrimId: "scrim-a",
      allScrimIds: allScrims,
      ...target,
    });

    expect(plan.scrimIds).toEqual(["scrim-a"]);
    expect(plan.userIds).toEqual(["captain"]);
  });

  it("mode 2 bans the whole team from this scrim", () => {
    const plan = planBan({
      mode: BanMode.teamThisScrim,
      thisScrimId: "scrim-a",
      allScrimIds: allScrims,
      ...target,
    });

    expect(plan.scrimIds).toEqual(["scrim-a"]);
    expect(plan.userIds).toEqual(["captain", "second", "third"]);
  });

  it("mode 3 bans the leader from every scrim", () => {
    const plan = planBan({
      mode: BanMode.leaderAllScrims,
      thisScrimId: "scrim-a",
      allScrimIds: allScrims,
      ...target,
    });

    expect(plan.scrimIds).toEqual(allScrims);
    expect(plan.userIds).toEqual(["captain"]);
  });

  it("mode 4 bans the whole team from every scrim", () => {
    const plan = planBan({
      mode: BanMode.teamAllScrims,
      thisScrimId: "scrim-a",
      allScrimIds: allScrims,
      ...target,
    });

    expect(plan.scrimIds).toEqual(allScrims);
    expect(plan.userIds).toEqual(["captain", "second", "third"]);
  });
});

describe("the slot numbers", () => {
  it("runs from start_from to start_from + total_slots - 1", () => {
    // BUG-4: the source's "Add Team" button offered `range(start_from,
    // 30)`, so a scrim with ten slots offered twenty numbers that did
    // not exist.
    expect(slotNumbersOf({ startFrom: 1, totalSlots: 3 })).toEqual([1, 2, 3]);
    expect(slotNumbersOf({ startFrom: 5, totalSlots: 3 })).toEqual([5, 6, 7]);
    expect(slotNumbersOf({ startFrom: 1, totalSlots: 30 })).toHaveLength(30);
  });
});

describe("the slot window", () => {
  it("covers a scrim that closed today and whose match has not started", () => {
    const scrim = makeScrim({
      status: "closed",
      closedAt: new Date("2026-03-15T06:00:00.000Z"),
      matchTime: new Date("2026-03-15T18:00:00.000Z"),
    });

    expect(isWithinSlotWindow(scrim, NOW)).toBe(true);
  });

  it("does not cover a scrim whose registration is still open", () => {
    const scrim = makeScrim({
      status: "open",
      closedAt: new Date("2026-03-15T06:00:00.000Z"),
      matchTime: new Date("2026-03-15T18:00:00.000Z"),
    });

    expect(isWithinSlotWindow(scrim, NOW)).toBe(false);
  });

  it("does not cover a scrim whose match has started", () => {
    const scrim = makeScrim({
      status: "closed",
      closedAt: new Date("2026-03-15T06:00:00.000Z"),
      matchTime: new Date("2026-03-15T06:30:00.000Z"),
    });

    expect(isWithinSlotWindow(scrim, NOW)).toBe(false);
  });

  it("does not cover a scrim that closed yesterday", () => {
    const scrim = makeScrim({
      status: "closed",
      closedAt: new Date("2026-03-14T06:00:00.000Z"),
      matchTime: new Date("2026-03-15T18:00:00.000Z"),
    });

    expect(isWithinSlotWindow(scrim, NOW)).toBe(false);
  });
});

describe("the start of the day", () => {
  it("is midnight in the given zone", () => {
    const ist = startOfDay(new Date("2026-03-15T12:00:00.000Z"), "Asia/Kolkata");

    // 2026-03-15 00:00 IST is 2026-03-14 18:30 UTC.
    expect(ist.toISOString()).toBe("2026-03-14T18:30:00.000Z");
  });
});
