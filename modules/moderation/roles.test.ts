/**
 * Parsing the member lists of the role commands, and the member targets
 * of the kick and ban commands.
 */

import { describe, expect, it } from "vitest";
import { parseMentionIds } from "./roles.js";
import { parseUserId } from "./members.js";

describe("parseMentionIds", () => {
  it("reads a list of mentions", () => {
    const ids = parseMentionIds("<@111111111111111111> <@222222222222222222>");

    expect(ids).toEqual(["111111111111111111", "222222222222222222"]);
  });

  it("reads the `!` form of a mention", () => {
    expect(parseMentionIds("<@!111111111111111111>")).toEqual([
      "111111111111111111",
    ]);
  });

  it("reads a bare id", () => {
    expect(parseMentionIds("111111111111111111")).toEqual([
      "111111111111111111",
    ]);
  });

  it("reads a mixture", () => {
    const ids = parseMentionIds("<@111111111111111111> and 222222222222222222");

    expect(ids).toEqual(["111111111111111111", "222222222222222222"]);
  });

  it("does not repeat a member", () => {
    const ids = parseMentionIds(
      "<@111111111111111111> <@111111111111111111>",
    );

    expect(ids).toEqual(["111111111111111111"]);
  });

  it("ignores the rest of the text", () => {
    expect(parseMentionIds("please give this to <@111111111111111111> thanks")).toEqual([
      "111111111111111111",
    ]);
  });

  it("returns nothing for text with no member in it", () => {
    expect(parseMentionIds("everybody")).toEqual([]);
  });
});

describe("parseUserId", () => {
  it("reads a mention", () => {
    expect(parseUserId("<@111111111111111111>")).toBe("111111111111111111");
  });

  it("reads the `!` form of a mention", () => {
    expect(parseUserId("<@!111111111111111111>")).toBe("111111111111111111");
  });

  it("reads a bare id", () => {
    expect(parseUserId("111111111111111111")).toBe("111111111111111111");
  });

  it("tolerates the whitespace around it", () => {
    expect(parseUserId("  111111111111111111  ")).toBe("111111111111111111");
  });

  it("refuses a name", () => {
    expect(parseUserId("somebody")).toBeNull();
  });

  it("refuses a number that is too short to be a snowflake", () => {
    expect(parseUserId("12345")).toBeNull();
  });
});
