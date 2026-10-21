/**
 * The tournament lifecycle.
 *
 * D26: the lifecycle is an explicit value, not a pair of nullable
 * timestamps. These tests pin down what the port promises:
 *
 *  - the transitions the lifecycle allows, and the one it does not;
 *  - that **pausing and closing are different states** — the source set
 *    `closed_at` for both, so the two were indistinguishable in the data;
 *  - that a full tournament cannot be opened;
 *  - that a closed tournament can be opened again, as the source's
 *    toggle allowed.
 */

import { describe, expect, it } from "vitest";
import {
  canOpenTourney,
  canTransitionTourney,
  isClosed,
  isPaused,
  isRegistrationOpen,
  nextTourneyStates,
  toggleTarget,
} from "./state.js";

describe("the tourney lifecycle", () => {
  it("knows four states", () => {
    expect(nextTourneyStates("draft")).toContain("open");
    expect(nextTourneyStates("open")).toContain("paused");
    expect(nextTourneyStates("paused")).toContain("open");
    expect(nextTourneyStates("closed")).toContain("open");
  });

  it("opens a draft", () => {
    expect(canTransitionTourney("draft", "open")).toBe(true);
  });

  it("pauses an open tournament and resumes a paused one", () => {
    expect(canTransitionTourney("open", "paused")).toBe(true);
    expect(canTransitionTourney("paused", "open")).toBe(true);
  });

  it("closes from every state but a closed one", () => {
    expect(canTransitionTourney("draft", "closed")).toBe(true);
    expect(canTransitionTourney("open", "closed")).toBe(true);
    expect(canTransitionTourney("paused", "closed")).toBe(true);
    expect(canTransitionTourney("closed", "closed")).toBe(false);
  });

  it("re-opens a closed tournament, as the source's toggle did", () => {
    expect(canTransitionTourney("closed", "open")).toBe(true);
  });

  it("tells pause and close apart", () => {
    // The whole point of D26: the source set `closed_at` for both, so a
    // paused tournament and a closed one looked the same in the data.
    expect(isPaused("paused")).toBe(true);
    expect(isClosed("paused")).toBe(false);

    expect(isClosed("closed")).toBe(true);
    expect(isPaused("closed")).toBe(false);
  });

  it("only accepts registrations while it is open", () => {
    expect(isRegistrationOpen("open")).toBe(true);
    expect(isRegistrationOpen("draft")).toBe(false);
    expect(isRegistrationOpen("paused")).toBe(false);
    expect(isRegistrationOpen("closed")).toBe(false);
  });

  it("refuses to open a full tournament", () => {
    const refusal = canOpenTourney({
      status: "draft",
      slotCount: 16,
      totalSlots: 16,
    });

    expect(refusal).toContain("already full");
  });

  it("opens a tournament that has room", () => {
    const refusal = canOpenTourney({
      status: "draft",
      slotCount: 15,
      totalSlots: 16,
    });

    expect(refusal).toBeNull();
  });

  it("refuses to open a tournament that is already open", () => {
    const refusal = canOpenTourney({
      status: "open",
      slotCount: 0,
      totalSlots: 16,
    });

    expect(refusal).toBe("This tournament is already open.");
  });

  it("says what the toggle button will do", () => {
    expect(toggleTarget("open")).toBe("paused");
    expect(toggleTarget("draft")).toBe("open");
    expect(toggleTarget("paused")).toBe("open");
    expect(toggleTarget("closed")).toBe("open");
  });
});
