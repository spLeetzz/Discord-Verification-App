import { describe, expect, it } from "vitest";

import {
  canTransition,
  classifyClaim,
  isClaimable,
  isValidSlotNumber,
  lastSlotNumber,
  nextStates,
  pickSlotToClaim,
  slotNumbers,
} from "./slots.js";
import type { SlotState } from "./types.js";

describe("slot numbering", () => {
  it("runs from start_from to start_from + total_slots - 1", () => {
    expect(slotNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(slotNumbers(5, 3)).toEqual([5, 6, 7]);
    expect(slotNumbers(10, 1)).toEqual([10]);
  });

  it("is empty when the scrim has no slots", () => {
    expect(slotNumbers(1, 0)).toEqual([]);
    expect(slotNumbers(1, -4)).toEqual([]);
  });

  it("knows the last number", () => {
    expect(lastSlotNumber(1, 30)).toBe(30);
    expect(lastSlotNumber(5, 30)).toBe(34);
    expect(lastSlotNumber(1, 0)).toBe(0);
  });

  it("rejects a number the scrim does not have", () => {
    // The source's "Add Team" button offered `range(start_from, 30)`, so a
    // scrim with 10 slots offered 20 numbers that did not exist.
    expect(isValidSlotNumber(30, 1, 30)).toBe(true);
    expect(isValidSlotNumber(31, 1, 30)).toBe(false);
    expect(isValidSlotNumber(0, 1, 30)).toBe(false);
    expect(isValidSlotNumber(7, 5, 3)).toBe(true);
    expect(isValidSlotNumber(12, 5, 3)).toBe(false);
    expect(isValidSlotNumber(1.5, 1, 3)).toBe(false);
  });
});

describe("the slot state machine", () => {
  it("lets a free slot be claimed, locked or banned", () => {
    expect(canTransition("free", "claimed")).toBe(true);
    expect(canTransition("free", "locked")).toBe(true);
    expect(canTransition("free", "banned")).toBe(true);
  });

  it("lets a claimed slot be released", () => {
    expect(canTransition("claimed", "free")).toBe(true);
    expect(canTransition("claimed", "locked")).toBe(false);
    expect(canTransition("claimed", "banned")).toBe(false);
  });

  it("lets a locked slot be released or banned", () => {
    expect(canTransition("locked", "free")).toBe(true);
    expect(canTransition("locked", "banned")).toBe(true);
    expect(canTransition("locked", "claimed")).toBe(false);
  });

  it("lets a banned slot be released", () => {
    expect(canTransition("banned", "free")).toBe(true);
    expect(canTransition("banned", "claimed")).toBe(false);
  });

  it("never lets a slot move to the state it is already in", () => {
    const states: SlotState[] = ["free", "claimed", "locked", "banned"];

    for (const state of states) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it("only lets a free slot be claimed", () => {
    expect(isClaimable("free")).toBe(true);
    expect(isClaimable("claimed")).toBe(false);
    expect(isClaimable("locked")).toBe(false);
    expect(isClaimable("banned")).toBe(false);
  });

  it("lists the states a slot may move to", () => {
    expect(nextStates("free")).toEqual(["claimed", "locked", "banned"]);
    expect(nextStates("claimed")).toEqual(["free"]);
  });
});

describe("picking a slot to claim", () => {
  it("takes the lowest free number", () => {
    const slots = [
      { num: 3, state: "claimed" as const },
      { num: 1, state: "free" as const },
      { num: 2, state: "free" as const },
    ];

    expect(pickSlotToClaim(slots)).toBe(1);
  });

  it("skips slots that are not claimable", () => {
    const slots = [
      { num: 1, state: "banned" as const },
      { num: 2, state: "locked" as const },
      { num: 3, state: "claimed" as const },
    ];

    expect(pickSlotToClaim(slots)).toBeNull();
  });

  it("returns null when there is nothing free", () => {
    expect(pickSlotToClaim([])).toBeNull();
  });
});

describe("classifying a claim", () => {
  it("reports a lost race when the slot is now claimed by somebody else", () => {
    // The conditional UPDATE matched no row because somebody else took
    // it between our read and our write.
    expect(classifyClaim("claimed")).toBe("taken");
  });

  it("reports an unavailable slot when it is not claimable", () => {
    expect(classifyClaim("banned")).toBe("unavailable");
    expect(classifyClaim("locked")).toBe("unavailable");
  });

  it("treats a vanished slot as a lost race", () => {
    expect(classifyClaim(null)).toBe("taken");
  });
});
