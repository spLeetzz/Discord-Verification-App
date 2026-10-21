import { describe, expect, it } from "vitest";

import { RegDeny } from "../../core/constants.js";
import {
  REGISTRATION_GUARDS,
  botMentionsRejected,
  countLines,
  duplicateTags,
  duplicateTeamName,
  elifChainApplies,
  evaluateRegistration,
  hasTeamToken,
  mentionCount,
  normalisedContent,
  oneRegistrationPerPerson,
  teamNameRequired,
} from "./requirements.js";
import type {
  MentionSummary,
  RegistrationContext,
  RegistrationSettings,
} from "./requirements.js";

const HUMAN: MentionSummary = { id: "111", isBot: false };
const BOT: MentionSummary = { id: "222", isBot: true };

const DEFAULT_SETTINGS: RegistrationSettings = {
  requiredMentions: 4,
  requiredLines: 0,
  teamnameCompulsion: false,
  multiregister: false,
  noDuplicateName: false,
  allowDuplicateTags: true,
};

interface ContextOverrides {
  readonly settings?: Partial<RegistrationSettings>;
  readonly rawContent?: string;
  readonly mentions?: readonly MentionSummary[];
  readonly authorId?: string;
  readonly bannedUserIds?: readonly string[];
  readonly claimedOwnerIds?: readonly string[];
  readonly claimedTeamNames?: readonly string[];
  readonly fakeTagMatches?: number;
  readonly teamName?: string;
}

function context(overrides: ContextOverrides = {}): RegistrationContext {
  return {
    settings: { ...DEFAULT_SETTINGS, ...overrides.settings },
    rawContent: overrides.rawContent ?? "",
    mentions: overrides.mentions ?? [],
    authorId: overrides.authorId ?? "author",
    bannedUserIds: new Set(overrides.bannedUserIds ?? []),
    claimedOwnerIds: new Set(overrides.claimedOwnerIds ?? []),
    claimedTeamNames: new Set(overrides.claimedTeamNames ?? []),
    fakeTagMatches: overrides.fakeTagMatches ?? 0,
    teamName: overrides.teamName ?? "Team Alpha",
  };
}

describe("the requirements matrix", () => {
  it("accepts a registration that breaks no rule", async () => {
    const reason = await evaluateRegistration(
      context({
        rawContent: "team alpha\n@a @b @c @d",
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      }),
    );

    expect(reason).toBeNull();
  });

  it("is an ordered list: the first match wins and the rest do not fire", async () => {
    // Every rule is broken at once. The team-name guard comes first, so
    // it is the one that answers.
    const reason = await evaluateRegistration(
      context({
        settings: {
          teamnameCompulsion: true,
          requiredMentions: 4,
          requiredLines: 5,
          noDuplicateName: true,
          allowDuplicateTags: false,
        },
        rawContent: "nothing to see here",
        mentions: [BOT, BOT, BOT, BOT],
        authorId: "banned",
        bannedUserIds: ["banned"],
        claimedOwnerIds: ["banned"],
        claimedTeamNames: ["Team Alpha"],
        fakeTagMatches: 2,
      }),
    );

    expect(reason).toBe(RegDeny.noteamname);
  });

  it("keeps the source's two independent checks independent of the chain", async () => {
    // The bot-mention check is an independent `if`, so it fires even when
    // the chain below it would also have fired.
    const ctx = context({
      settings: { requiredMentions: 4, requiredLines: 10 },
      rawContent: "team alpha",
      mentions: [BOT, HUMAN, HUMAN, HUMAN],
    });

    expect(botMentionsRejected(ctx)).toBe(RegDeny.botmention);
    // ...and the chain does not run, because the `if` above it was true.
    expect(elifChainApplies(ctx)).toBe(false);
    expect(await evaluateRegistration(ctx)).toBe(RegDeny.botmention);
  });

  it("skips the whole elif chain when the scrim asks for no mentions", async () => {
    // `if scrim.required_mentions and ...` is falsy when the count is
    // zero, so the chain hanging off it never runs. That is a source
    // quirk and it is preserved.
    const ctx = context({
      settings: { requiredMentions: 0, requiredLines: 10 },
      rawContent: "one line only",
      mentions: [BOT],
      authorId: "banned",
      bannedUserIds: ["banned"],
    });

    expect(elifChainApplies(ctx)).toBe(false);
    expect(botMentionsRejected(ctx)).toBeNull();
    // The "too few lines" and "banned" rules never get a chance to fire.
    expect(await evaluateRegistration(ctx)).toBeNull();
  });

  describe("guard 1: team name", () => {
    it("refuses when the scrim demands a team name and there is none", () => {
      const ctx = context({
        settings: { teamnameCompulsion: true },
        rawContent: "hello there",
      });

      expect(teamNameRequired(ctx)).toBe(RegDeny.noteamname);
    });

    it("accepts when the message contains a team token", () => {
      const ctx = context({
        settings: { teamnameCompulsion: true },
        rawContent: "Team: Alpha",
      });

      expect(teamNameRequired(ctx)).toBeNull();
    });

    it("is inert when the scrim does not demand a team name", () => {
      const ctx = context({ rawContent: "hello there" });

      expect(teamNameRequired(ctx)).toBeNull();
    });

    it("matches the source's team.* search, so a word containing team passes", () => {
      // The source searched for `r"team.*"` anywhere in the message, so
      // "steam" satisfied the team-name rule. Preserved, not fixed.
      expect(hasTeamToken("steam")).toBe(true);
      expect(hasTeamToken("nothing here")).toBe(false);
    });
  });

  describe("guard 2: bot mentions", () => {
    it("refuses a bot mention", () => {
      const ctx = context({ mentions: [HUMAN, BOT] });

      expect(botMentionsRejected(ctx)).toBe(RegDeny.botmention);
    });

    it("accepts when every mention is a human", () => {
      const ctx = context({ mentions: [HUMAN, HUMAN] });

      expect(botMentionsRejected(ctx)).toBeNull();
    });
  });

  describe("guard 3: mention count", () => {
    it("refuses too few mentions", () => {
      const ctx = context({
        settings: { requiredMentions: 4 },
        mentions: [HUMAN, HUMAN],
      });

      expect(mentionCount(ctx)).toBe(RegDeny.nomention);
    });

    it("accepts exactly the required number", () => {
      const ctx = context({
        settings: { requiredMentions: 4 },
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      });

      expect(mentionCount(ctx)).toBeNull();
    });
  });

  describe("guard 4: banned users", () => {
    it("refuses a banned author", async () => {
      const ctx = context({
        authorId: "banned",
        bannedUserIds: ["banned"],
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      });

      expect(await evaluateRegistration(ctx)).toBe(RegDeny.banned);
    });

    it("accepts a user who is not banned", async () => {
      const ctx = context({
        authorId: "fine",
        bannedUserIds: ["banned"],
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      });

      expect(await evaluateRegistration(ctx)).toBeNull();
    });
  });

  describe("guard 5: required lines", () => {
    it("refuses a message that is too short", async () => {
      const withChain = context({
        settings: { requiredLines: 3 },
        rawContent: "one\ntwo",
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      });

      expect(await evaluateRegistration(withChain)).toBe(RegDeny.nolines);
    });

    it("accepts a message with enough lines", async () => {
      const withChain = context({
        settings: { requiredLines: 3 },
        rawContent: "one\ntwo\nthree",
        mentions: [HUMAN, HUMAN, HUMAN, HUMAN],
      });

      expect(await evaluateRegistration(withChain)).toBeNull();
    });

    it("counts lines the way Python's splitlines does", () => {
      expect(countLines("")).toBe(0);
      expect(countLines("one")).toBe(1);
      expect(countLines("one\ntwo")).toBe(2);
      expect(countLines("one\r\ntwo")).toBe(2);
      expect(countLines("one two")).toBe(2);
    });
  });

  describe("guard 6: one registration per person", () => {
    it("refuses a second registration", () => {
      const ctx = context({
        authorId: "captain",
        claimedOwnerIds: ["captain"],
      });

      expect(oneRegistrationPerPerson(ctx)).toBe(RegDeny.multiregister);
    });

    it("accepts a second registration when the scrim allows it", () => {
      const ctx = context({
        settings: { multiregister: true },
        authorId: "captain",
        claimedOwnerIds: ["captain"],
      });

      expect(oneRegistrationPerPerson(ctx)).toBeNull();
    });
  });

  describe("guard 7: duplicate team names", () => {
    it("refuses a name that is already taken", () => {
      const ctx = context({
        settings: { noDuplicateName: true },
        teamName: "Team Alpha",
        claimedTeamNames: ["Team Alpha"],
      });

      expect(duplicateTeamName(ctx)).toBe(RegDeny.duplicate);
    });

    it("accepts a name that is free", () => {
      const ctx = context({
        settings: { noDuplicateName: true },
        teamName: "Team Beta",
        claimedTeamNames: ["Team Alpha"],
      });

      expect(duplicateTeamName(ctx)).toBeNull();
    });
  });

  describe("guard 8: duplicate tags", () => {
    it("refuses a member who is already on another slot", () => {
      const ctx = context({
        settings: { allowDuplicateTags: false },
        fakeTagMatches: 1,
      });

      expect(duplicateTags(ctx)).toBe(RegDeny.faketag);
    });

    it("accepts when the scrim allows duplicate tags", () => {
      const ctx = context({
        settings: { allowDuplicateTags: true },
        fakeTagMatches: 3,
      });

      expect(duplicateTags(ctx)).toBeNull();
    });
  });

  it("normalises the content without touching the message", () => {
    const ctx = context({ rawContent: "ＴＥＡＭ ＡＬＰＨＡ" });

    expect(normalisedContent(ctx)).toBe("team alpha");
  });

  it("has the eight guards in the source's order", () => {
    expect(REGISTRATION_GUARDS).toHaveLength(8);
  });
});
