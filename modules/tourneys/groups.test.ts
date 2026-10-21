/**
 * The group algorithm.
 *
 * **Groups are a flat chunk of the ordered slot list by `group_size`.**
 * The source's `split_list` did exactly that, and these tests pin the
 * exact grouping down — including the short last group, which is the
 * only interesting case.
 *
 * There is no standings, no points, no seeding and no progression, and
 * these tests make sure nothing sneaks in.
 */

import { describe, expect, it } from "vitest";
import {
  chunkIntoGroups,
  getGroup,
  groupListLine,
  groupSlots,
  renderGroupList,
} from "./groups.js";

/** A slot list, as the database would hand it over. */
function slots(count: number, from = 1) {
  return Array.from({ length: count }, (_unused, index) => ({
    num: from + index,
    teamName: `Team ${from + index}`,
  }));
}

describe("the group algorithm", () => {
  it("chunks a list of eight into two groups of four", () => {
    const groups = chunkIntoGroups(slots(8), 4);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.number).toBe(1);
    expect(groups[0]?.slots.map((slot) => slot.num)).toEqual([1, 2, 3, 4]);
    expect(groups[1]?.number).toBe(2);
    expect(groups[1]?.slots.map((slot) => slot.num)).toEqual([5, 6, 7, 8]);
  });

  it("leaves the last group short when the count is not a multiple", () => {
    const groups = chunkIntoGroups(slots(10), 4);

    expect(groups).toHaveLength(3);
    expect(groups[2]?.slots.map((slot) => slot.num)).toEqual([9, 10]);
  });

  it("makes one group per team when the group size is one", () => {
    const groups = chunkIntoGroups(slots(3), 1);

    expect(groups).toHaveLength(3);
    expect(groups[2]?.slots.map((slot) => slot.num)).toEqual([3]);
  });

  it("produces no groups for an empty list", () => {
    expect(chunkIntoGroups([], 4)).toEqual([]);
  });

  it("produces no groups for a group size of zero", () => {
    // `split_list` would have raised `ValueError` on a zero step; the
    // port answers "no groups" and lets the caller decide what an unset
    // group size means.
    expect(chunkIntoGroups(slots(4), 0)).toEqual([]);
  });

  it("orders the slots by their number before chunking", () => {
    const groups = groupSlots(
      [
        { num: 3, teamName: "C" },
        { num: 1, teamName: "A" },
        { num: 2, teamName: "B" },
        { num: 4, teamName: "D" },
      ],
      2,
    );

    expect(groups[0]?.slots.map((slot) => slot.teamName)).toEqual(["A", "B"]);
    expect(groups[1]?.slots.map((slot) => slot.teamName)).toEqual(["C", "D"]);
  });

  it("finds one group by its number", () => {
    const list = slots(10);

    expect(getGroup(list, 4, 1)?.slots.map((slot) => slot.num)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(getGroup(list, 4, 3)?.slots.map((slot) => slot.num)).toEqual([9, 10]);
    expect(getGroup(list, 4, 4)).toBeNull();
    expect(getGroup(list, 4, 0)).toBeNull();
  });

  it("prints the slot list the way the source printed it", () => {
    // The source: `f"Slot {idx:02}  ->  {slot.team_name}"`, counting from
    // `tourney.slotlist_start`.
    expect(groupListLine({ num: 1, teamName: "Team Awesome" }, 0, 2)).toBe(
      "Slot 02  ->  Team Awesome",
    );

    expect(groupListLine({ num: 3, teamName: "Team Two" }, 1, 2)).toBe(
      "Slot 03  ->  Team Two",
    );
  });

  it("renders the published list as a code block", () => {
    const groups = chunkIntoGroups(slots(3), 2);

    const rendered = renderGroupList(groups[0] as (typeof groups)[number], 1);

    expect(rendered).toBe(
      ["```", "Slot 01  ->  Team 1", "Slot 02  ->  Team 2", "```"].join("\n"),
    );
  });

  it("does not invent standings, points or progression", () => {
    // The group is a bucket of teams. Nothing else.
    const groups = chunkIntoGroups(slots(4), 2);

    expect(Object.keys(groups[0] as object).sort()).toEqual(["number", "slots"]);
  });
});
