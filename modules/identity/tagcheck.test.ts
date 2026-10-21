/**
 * The tag-check rules, and what the reply says about the team.
 */

import { describe, expect, it } from "vitest";
import {
  buildTagCheckSummary,
  checkTagCheckMessage,
  TAG_CHECK_GUARDS,
} from "./tagcheck.js";
import type { TagCheckMention } from "./tagcheck.js";

/** A mention of a human. */
const human = (id: string): TagCheckMention => ({ id, isBot: false });

/** A mention of a bot. */
const bot = (id: string): TagCheckMention => ({ id, isBot: true });

describe("the rules of a tag-check channel", () => {
  it("accepts a message with enough human mentions", () => {
    expect(
      checkTagCheckMessage({
        requiredMentions: 2,
        mentions: [human("1"), human("2")],
      }),
    ).toBeNull();
  });

  it("refuses a message that mentions a bot", () => {
    expect(
      checkTagCheckMessage({
        requiredMentions: 2,
        mentions: [human("1"), bot("2")],
      }),
    ).toBe("Kindly mention your real teammate.");
  });

  it("refuses a message with too few mentions", () => {
    expect(
      checkTagCheckMessage({
        requiredMentions: 3,
        mentions: [human("1"), human("2")],
      }),
    ).toBe("You need to mention `3 teammates`.");
  });

  it("says 'teammate' when only one is needed", () => {
    expect(
      checkTagCheckMessage({
        requiredMentions: 1,
        mentions: [],
      }),
    ).toBe("You need to mention `1 teammate`.");
  });

  it("tells the captain about the bot first", () => {
    // The order is Quotient's: "you mentioned a bot" is more useful than
    // "you mentioned too few people".
    expect(
      checkTagCheckMessage({
        requiredMentions: 5,
        mentions: [bot("1")],
      }),
    ).toBe("Kindly mention your real teammate.");
  });

  it("accepts anything in a channel that asks for no mentions", () => {
    // A channel with `required_mentions = 0` is a channel that does not
    // check — the bot-mention rule must not fire there either.
    expect(
      checkTagCheckMessage({
        requiredMentions: 0,
        mentions: [bot("1")],
      }),
    ).toBeNull();
  });

  it("has the bot rule before the count rule", () => {
    expect(TAG_CHECK_GUARDS.map((guard) => guard.id)).toEqual([
      "bot_mentions",
      "insufficient_mentions",
    ]);
  });

  it("counts only the mentions it was given", () => {
    // A role mention is not a teammate. The listener only hands over the
    // users that were mentioned, so the count cannot include a role.
    expect(
      checkTagCheckMessage({
        requiredMentions: 2,
        mentions: [human("1")],
      }),
    ).toBe("You need to mention `2 teammates`.");
  });
});

describe("the reply", () => {
  const author = { toString: () => "<@999>" };

  it("takes the team name out of the message", () => {
    const summary = buildTagCheckSummary({
      content: "Team: Alpha",
      author,
      authorId: "999",
      mentions: [human("1"), human("2")],
    });

    expect(summary.teamName).toBe("Team Alpha");
  });

  it("falls back to the author's team when the message has no name", () => {
    const summary = buildTagCheckSummary({
      content: "we are the champions",
      author,
      authorId: "999",
      mentions: [human("1")],
    });

    expect(summary.teamName).toBe("<@999>'s team");
  });

  it("lists the players that were mentioned", () => {
    const summary = buildTagCheckSummary({
      content: "Team: Alpha",
      author,
      authorId: "999",
      mentions: [human("1"), human("2")],
    });

    expect(summary.players).toBe("<@1>, <@2>");
  });

  it("falls back to the author when nobody was mentioned", () => {
    const summary = buildTagCheckSummary({
      content: "Team: Alpha",
      author,
      authorId: "999",
      mentions: [],
    });

    expect(summary.players).toBe("<@999>");
  });

  it("keeps the name the ported helper produced, quirks and all", () => {
    // `find_team` is a verbatim port: the search is for the lowercase
    // word "team", the match stops at the end of the line, and the words
    // "team" and "name" are stripped out of the result.
    const summary = buildTagCheckSummary({
      content: "Team Name: The Blue Whale\nsecond line",
      author,
      authorId: "999",
      mentions: [],
    });

    expect(summary.teamName).toBe("Team The Blue Whale");
  });
});
