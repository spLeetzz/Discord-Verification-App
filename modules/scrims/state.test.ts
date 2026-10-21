import { describe, expect, it } from "vitest";

import {
  canTransitionScrim,
  isRegistrationOpen,
  nextScrimStates,
  shouldAutoOpen,
} from "./state.js";

describe("the scrim lifecycle", () => {
  it("goes draft -> open -> closed", () => {
    expect(canTransitionScrim("draft", "open")).toBe(true);
    expect(canTransitionScrim("open", "closed")).toBe(true);
  });

  it("can be opened again after it was closed", () => {
    expect(canTransitionScrim("closed", "open")).toBe(true);
  });

  it("cannot be closed while it is already closed", () => {
    expect(canTransitionScrim("closed", "closed")).toBe(false);
  });

  it("cannot be opened while it is already open", () => {
    expect(canTransitionScrim("open", "open")).toBe(false);
  });

  it("lists the states a scrim may move to", () => {
    expect(nextScrimStates("draft")).toEqual(["open", "closed"]);
    expect(nextScrimStates("open")).toEqual(["closed"]);
    expect(nextScrimStates("closed")).toEqual(["open"]);
  });

  it("knows when registration is open", () => {
    expect(isRegistrationOpen("open")).toBe(true);
    expect(isRegistrationOpen("draft")).toBe(false);
    expect(isRegistrationOpen("closed")).toBe(false);
  });
});

describe("the daily auto-open", () => {
  it("opens an enabled scrim on one of its days", () => {
    expect(
      shouldAutoOpen({
        enabled: true,
        status: "closed",
        today: "monday",
        openDays: ["monday", "tuesday"],
      }),
    ).toBe(true);
  });

  it("does not open a disabled scrim", () => {
    expect(
      shouldAutoOpen({
        enabled: false,
        status: "closed",
        today: "monday",
        openDays: ["monday"],
      }),
    ).toBe(false);
  });

  it("does not open a scrim on a day it does not open on", () => {
    expect(
      shouldAutoOpen({
        enabled: true,
        status: "closed",
        today: "sunday",
        openDays: ["monday"],
      }),
    ).toBe(false);
  });

  it("does not re-open a scrim that is already open", () => {
    expect(
      shouldAutoOpen({
        enabled: true,
        status: "open",
        today: "monday",
        openDays: ["monday"],
      }),
    ).toBe(false);
  });
});
