import { describe, expect, it } from "vitest";
import {
  findTeam,
  normaliseMessageContent,
  normaliseTeamName,
  teamNameFallback,
  TEAM_NAME_MAX_LENGTH,
} from "./team-name.js";

/**
 * The author of a message, as Quotient's `str(author)` would render it.
 *
 * `discord.Member.__str__` returns the mention, so the fallback name reads
 * `<@123>'s team`.
 */
const author = { toString: () => "<@123>" };

describe("findTeam", () => {
  it("takes the team name out of a registration message", () => {
    expect(findTeam({ content: "Team: Alpha", author })).toBe("Team Alpha");
  });

  it("falls back to the author when there is no team word at all", () => {
    expect(findTeam({ content: "we are the champions", author })).toBe(
      "<@123>'s team",
    );
  });

  it("falls back to the author when the team word leaves nothing behind", () => {
    // The word "team" is the whole match, and stripping it leaves nothing.
    expect(findTeam({ content: "team", author })).toBe("<@123>'s team");
  });

  it("falls back to the author when the match is only punctuation", () => {
    expect(findTeam({ content: "team :-)", author })).toBe("<@123>'s team");
  });

  it("only reads the first line", () => {
    // `.` does not match a newline, so the second line is not part of the
    // name — this is D27's first-line-only rule.
    expect(findTeam({ content: "team Alpha\nteam Beta", author })).toBe(
      "Team Alpha",
    );
  });

  it("removes mentions out of the name", () => {
    expect(findTeam({ content: "team <@123> Alpha", author })).toBe(
      "Team Alpha",
    );
  });

  it("removes the words team and name out of the name", () => {
    expect(findTeam({ content: "Team Name: Foo", author })).toBe("Team Foo");
  });

  it("title-cases what is left", () => {
    expect(findTeam({ content: "team THE BLUE WHALE", author })).toBe(
      "Team The Blue Whale",
    );
  });

  it("searches the lower-cased text", () => {
    // The word has to be lower-case to be found, and the text is lower-cased
    // before the search.
    expect(findTeam({ content: "TEAM Alpha", author })).toBe("Team Alpha");
  });

  it("can be asked to search the raw text", () => {
    // With the raw content the search is case-sensitive, exactly as
    // Quotient's `find_team` was before it lower-cased the message.
    expect(
      findTeam({ content: "TEAM Alpha", author }, { normalise: false }),
    ).toBe("<@123>'s team");
  });

  it("strips the word team out of the middle of a word", () => {
    // Quotient's regex removes "team" wherever it appears.
    expect(findTeam({ content: "teamwork squad", author })).toBe(
      "Team Work Squad",
    );
  });
});

describe("normaliseMessageContent", () => {
  it("lower-cases and normalises", () => {
    expect(normaliseMessageContent("TEAM ﬁ")).toBe("team fi");
  });

  it("does not mutate the message it is given", () => {
    const content = "TEAM Alpha";
    normaliseMessageContent(content);

    expect(content).toBe("TEAM Alpha");
  });
});

describe("teamNameFallback", () => {
  it("is the author followed by 's team", () => {
    expect(teamNameFallback(author)).toBe("<@123>'s team");
  });
});

describe("normaliseTeamName", () => {
  it("applies the same normalisation to a typed name", () => {
    expect(normaliseTeamName("alpha")).toBe("Team Alpha");
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(normaliseTeamName("!!!")).toBe("");
  });
});

describe("TEAM_NAME_MAX_LENGTH", () => {
  it("is the 30 characters Quotient truncated to", () => {
    expect(TEAM_NAME_MAX_LENGTH).toBe(30);
  });
});
