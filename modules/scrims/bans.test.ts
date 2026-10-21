import { describe, expect, it } from "vitest";

import {
  banHasExpiry,
  bannedScrimsForMode,
  bannedUsersForMode,
  planBan,
} from "./bans.js";
import { BAN_MODES, BanMode } from "./types.js";

const TARGET = {
  leaderId: "captain",
  memberIds: ["captain", "second", "third"],
};

const ALL_SCRIMS = ["scrim-a", "scrim-b"];

describe("the ban matrix", () => {
  it("has four modes", () => {
    expect(BAN_MODES).toEqual([1, 2, 3, 4]);
  });

  it("mode 1 bans the leader from this scrim", () => {
    const plan = planBan({
      mode: BanMode.leaderThisScrim,
      target: TARGET,
      thisScrimId: "scrim-a",
      allScrimIds: ALL_SCRIMS,
    });

    expect(plan.entries).toEqual([{ scrimId: "scrim-a", userId: "captain" }]);
  });

  it("mode 2 bans the whole team from this scrim", () => {
    const plan = planBan({
      mode: BanMode.teamThisScrim,
      target: TARGET,
      thisScrimId: "scrim-a",
      allScrimIds: ALL_SCRIMS,
    });

    expect(plan.entries).toEqual([
      { scrimId: "scrim-a", userId: "captain" },
      { scrimId: "scrim-a", userId: "second" },
      { scrimId: "scrim-a", userId: "third" },
    ]);
  });

  it("mode 3 bans the leader from every scrim", () => {
    const plan = planBan({
      mode: BanMode.leaderAllScrims,
      target: TARGET,
      thisScrimId: "scrim-a",
      allScrimIds: ALL_SCRIMS,
    });

    expect(plan.entries).toEqual([
      { scrimId: "scrim-a", userId: "captain" },
      { scrimId: "scrim-b", userId: "captain" },
    ]);
  });

  it("mode 4 bans the whole team from every scrim", () => {
    const plan = planBan({
      mode: BanMode.teamAllScrims,
      target: TARGET,
      thisScrimId: "scrim-a",
      allScrimIds: ALL_SCRIMS,
    });

    expect(plan.entries).toHaveLength(6);
    expect(plan.entries).toContainEqual({
      scrimId: "scrim-b",
      userId: "third",
    });
  });

  it("falls back to the leader when the team list is empty", () => {
    expect(
      bannedUsersForMode(BanMode.teamThisScrim, {
        leaderId: "captain",
        memberIds: [],
      }),
    ).toEqual(["captain"]);
  });

  it("scopes a single-scrim mode to that scrim", () => {
    expect(
      bannedScrimsForMode(BanMode.leaderThisScrim, "scrim-a", ALL_SCRIMS),
    ).toEqual(["scrim-a"]);
  });

  it("scopes an all-scrims mode to every scrim", () => {
    expect(
      bannedScrimsForMode(BanMode.teamAllScrims, "scrim-a", ALL_SCRIMS),
    ).toEqual(ALL_SCRIMS);
  });

  it("skips a user who is already banned from that scrim", () => {
    const plan = planBan({
      mode: BanMode.teamThisScrim,
      target: TARGET,
      thisScrimId: "scrim-a",
      allScrimIds: ALL_SCRIMS,
      isBanned: (scrimId, userId) =>
        scrimId === "scrim-a" && userId === "second",
    });

    expect(plan.entries).toEqual([
      { scrimId: "scrim-a", userId: "captain" },
      { scrimId: "scrim-a", userId: "third" },
    ]);
    expect(plan.skipped).toBe(1);
  });

  it("knows whether a ban expires", () => {
    expect(banHasExpiry(null)).toBe(false);
    expect(banHasExpiry(new Date())).toBe(true);
  });
});
