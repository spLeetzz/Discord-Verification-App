/**
 * The requirements matrix.
 *
 * The matrix is an **ordered list of guards**: the first one that
 * refuses wins and the rest do not fire. These tests pin that down, and
 * they pin the two source quirks the port preserves:
 *
 *  - the `elif` chain is skipped entirely when `required_mentions` is
 *    `0`, so the banned-user, line and fake-tag checks stop firing;
 *  - the team-name check is independent of everything else.
 */

import { describe, expect, it } from "vitest";
import { RegDeny } from "../../core/constants.js";
import {
  REGISTRATION_GUARDS,
  countLines,
  elifChainApplies,
  evaluateRegistration,
  hasTeamToken,
  normalisedContent,
} from "./requirements.js";
import type { RegistrationContext } from "./requirements.js";

/** A context with everything switched off. */
function context(overrides: Partial<RegistrationContext> = {}): RegistrationContext {
  return {
    settings: {
      requiredMentions: 0,
      requiredLines: 0,
      teamnameCompulsion: false,
      multiregister: false,
      noDuplicateName: false,
      allowDuplicateTags: true,
    },
    rawContent: "",
    mentions: [],
    authorId: "author",
    bannedUserIds: new Set(),
    claimedOwnerIds: new Set(),
    claimedTeamNames: new Set(),
    fakeTagMatches: 0,
    teamName: "Team Nobody",
    ...overrides,
  };
}

/** A context that satisfies every guard. */
function clean(overrides: Partial<RegistrationContext> = {}): RegistrationContext {
  return context({
    settings: {
      requiredMentions: 1,
      requiredLines: 0,
      teamnameCompulsion: false,
      multiregister: false,
      noDuplicateName: false,
      allowDuplicateTags: true,
    },
    rawContent: "team name here",
    mentions: [{ id: "a", isBot: false }],
    ...overrides,
  });
}

describe("the requirements matrix", () => {
  it("is an ordered list", () => {
    expect(REGISTRATION_GUARDS.length).toBe(8);
    expect(REGISTRATION_GUARDS.every((guard) => typeof guard === "function")).toBe(
      true,
    );
  });

  it("accepts a registration that satisfies every guard", async () => {
    await expect(evaluateRegistration(clean())).resolves.toBeNull();
  });

  it("refuses a message with no team name when one is required", async () => {
    const ctx = clean({
      settings: {
        requiredMentions: 1,
        requiredLines: 0,
        teamnameCompulsion: true,
        multiregister: false,
        noDuplicateName: false,
        allowDuplicateTags: true,
      },
      rawContent: "hello there",
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.noteamname);
  });

  it("refuses a bot mention", async () => {
    const ctx = clean({
      mentions: [
        { id: "a", isBot: false },
        { id: "b", isBot: true },
      ],
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.botmention);
  });

  it("refuses a message with too few mentions", async () => {
    const ctx = clean({
      settings: {
        requiredMentions: 3,
        requiredLines: 0,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: false,
        allowDuplicateTags: true,
      },
      mentions: [{ id: "a", isBot: false }],
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.nomention);
  });

  it("refuses a banned user", async () => {
    const ctx = clean({ bannedUserIds: new Set(["author"]) });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.banned);
  });

  it("refuses a message with too few lines", async () => {
    const ctx = clean({
      settings: {
        requiredMentions: 1,
        requiredLines: 3,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: false,
        allowDuplicateTags: true,
      },
      rawContent: "one line",
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.nolines);
  });

  it("refuses a duplicate team name", async () => {
    const ctx = clean({
      settings: {
        requiredMentions: 1,
        requiredLines: 0,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: true,
        allowDuplicateTags: true,
      },
      claimedTeamNames: new Set(["Team Nobody"]),
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.duplicate);
  });

  it("refuses a second registration by the same person", async () => {
    const ctx = clean({ claimedOwnerIds: new Set(["author"]) });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.multiregister);
  });

  it("refuses a fake tag", async () => {
    const ctx = clean({
      settings: {
        requiredMentions: 1,
        requiredLines: 0,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: false,
        allowDuplicateTags: false,
      },
      fakeTagMatches: 1,
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.faketag);
  });

  it("lets the first match win and does not fire the rest", async () => {
    // Every guard that could refuse is satisfied except the first one.
    const ctx = clean({
      settings: {
        requiredMentions: 1,
        requiredLines: 99,
        teamnameCompulsion: true,
        multiregister: false,
        noDuplicateName: true,
        allowDuplicateTags: false,
      },
      rawContent: "hello world",
      bannedUserIds: new Set(["author"]),
      claimedOwnerIds: new Set(["author"]),
      claimedTeamNames: new Set(["Team Nobody"]),
      fakeTagMatches: 3,
    });

    // The team-name check is first and it is independent, so it is the
    // only reason that comes back.
    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.noteamname);
  });

  it("skips the whole elif chain when no mentions are required", async () => {
    // The source's chain hung off
    // `if tourney.required_mentions and not all(mentions are humans)`,
    // so a tournament that asked for no mentions never ran the banned,
    // line or fake-tag checks.
    const ctx = context({
      settings: {
        requiredMentions: 0,
        requiredLines: 99,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: false,
        allowDuplicateTags: false,
      },
      rawContent: "one line",
      bannedUserIds: new Set(["author"]),
      fakeTagMatches: 5,
    });

    expect(elifChainApplies(ctx)).toBe(false);

    await expect(evaluateRegistration(ctx)).resolves.toBeNull();
  });

  it("runs the process-stage guards whatever the mention count is", async () => {
    // The duplicate-name and one-registration checks were outside the
    // chain in the source, so they ran even with `required_mentions` at
    // zero.
    const ctx = context({
      settings: {
        requiredMentions: 0,
        requiredLines: 0,
        teamnameCompulsion: false,
        multiregister: false,
        noDuplicateName: true,
        allowDuplicateTags: true,
      },
      claimedTeamNames: new Set(["Team Nobody"]),
    });

    await expect(evaluateRegistration(ctx)).resolves.toBe(RegDeny.duplicate);
  });

  it("normalises a copy of the content and never the message", () => {
    const ctx = clean({ rawContent: "TEAM  Awesome" });

    expect(normalisedContent(ctx)).toBe("team  awesome");
    expect(ctx.rawContent).toBe("TEAM  Awesome");
  });

  it("counts lines the way Python's splitlines does", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\r\ntwo")).toBe(2);
  });

  it("finds a team token the way the source's regex did", () => {
    expect(hasTeamToken("team name")).toBe(true);
    // The source searched for the literal lowercase `team`, so "steam"
    // passed the check.
    expect(hasTeamToken("steam name")).toBe(true);
    expect(hasTeamToken("nothing here")).toBe(false);
  });
});
