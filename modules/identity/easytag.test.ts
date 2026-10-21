/**
 * The easy-tag rules.
 *
 * The extraction is the interesting part: Quotient's one regular
 * expression, `\b\d{18}\b|\b@\w+`, did not do what the message beside it
 * promised. These tests pin down what the port does instead.
 */

import { describe, expect, it } from "vitest";
import {
  buildEasyTagReply,
  extractEasyTags,
  isRawId,
  NO_TAG_MESSAGE,
  parseFullTag,
  resolveEasyTag,
} from "./easytag.js";
import type { EasyTagMember } from "./easytag.js";

/** A member with a name, a display name and an id. */
function member(
  id: string,
  username: string,
  displayName = username,
): EasyTagMember {
  return { id, username, displayName };
}

describe("extractEasyTags", () => {
  it("matches a full tag whole", () => {
    // The source bug (B14): `\b@\w+` stopped before the discriminator, so
    // `@their_full_discord_tag#1234` was read as `@their_full_discord_tag`
    // — the very form the error message advertises.
    expect(extractEasyTags("@their_full_discord_tag#1234")).toEqual([
      "@their_full_discord_tag#1234",
    ]);
  });

  it("keeps the discriminator when the tag is surrounded by other text", () => {
    expect(extractEasyTags("captain @player_one#4321 and @player_two#8765")).toEqual([
      "@player_one#4321",
      "@player_two#8765",
    ]);
  });

  it("matches a bare name", () => {
    expect(extractEasyTags("@their_name")).toEqual(["@their_name"]);
  });

  it("matches a name at the very start of a message", () => {
    // The second source bug: `\b` in front of the `@` needs a word
    // character before it, and the start of a message has none.
    expect(extractEasyTags("@their_name is here")).toEqual(["@their_name"]);
  });

  it("matches a name after a space", () => {
    expect(extractEasyTags("hey @their_name")).toEqual(["@their_name"]);
  });

  it("does not read an email address as a mention", () => {
    expect(extractEasyTags("write to foo@bar.com please")).toEqual([]);
  });

  it("finds a raw account id", () => {
    expect(extractEasyTags("123456789012345678")).toEqual([
      "123456789012345678",
    ]);
  });

  it("finds a real mention once, as the id", () => {
    // `<@123>` is an id with an `@` in front of it. Both the id pattern
    // and the tag pattern see it, and the tag is dropped so the resolver
    // is not asked to match a name that is a number.
    expect(extractEasyTags("<@123456789012345678>")).toEqual([
      "123456789012345678",
    ]);
  });

  it("keeps the order the tags appear in", () => {
    expect(extractEasyTags("@one#1111 then 123456789012345678 then @two#2222")).toEqual([
      "@one#1111",
      "123456789012345678",
      "@two#2222",
    ]);
  });

  it("drops a duplicate", () => {
    expect(extractEasyTags("@one#1111 @one#1111")).toEqual(["@one#1111"]);
  });

  it("finds nothing in a message without a tag", () => {
    expect(extractEasyTags("good luck everyone")).toEqual([]);
  });

  it("does not carry the state of one call into the next", () => {
    // The pattern is global, so a stale `lastIndex` would swallow the
    // first match of the second call.
    expect(extractEasyTags("@one#1111")).toEqual(["@one#1111"]);
    expect(extractEasyTags("@two#2222")).toEqual(["@two#2222"]);
  });
});

describe("parseFullTag", () => {
  it("splits a full tag into its name and its discriminator", () => {
    expect(parseFullTag("@player_one#4321")).toEqual({
      name: "player_one",
      discriminator: "4321",
    });
  });

  it("answers null for a tag without a discriminator", () => {
    expect(parseFullTag("@player_one")).toBeNull();
  });

  it("answers null for something that is not a tag", () => {
    expect(parseFullTag("123456789012345678")).toBeNull();
  });
});

describe("isRawId", () => {
  it("accepts a snowflake", () => {
    expect(isRawId("123456789012345678")).toBe(true);
  });

  it("rejects a short number", () => {
    expect(isRawId("1234")).toBe(false);
  });

  it("rejects a number that is too long", () => {
    expect(isRawId("12345678901234567890123")).toBe(false);
  });
});

describe("resolveEasyTag", () => {
  const members = [
    member("111111111111111111", "alpha", "Alpha"),
    member("222222222222222222", "bravo", "Bravo"),
    member("333333333333333333", "charlie", "Charlie"),
  ];

  it("resolves a raw id", () => {
    expect(resolveEasyTag("222222222222222222", members)).toBe(
      "222222222222222222",
    );
  });

  it("resolves a mention's id", () => {
    expect(resolveEasyTag("@222222222222222222", members)).toBe(
      "222222222222222222",
    );
  });

  it("resolves a full tag by its name and discriminator", () => {
    expect(resolveEasyTag("@bravo#2222", members)).toBe("222222222222222222");
  });

  it("resolves a full tag by its discriminator when the name is stale", () => {
    // Discord lets a member change their name, and the tag a captain
    // copied still carries the old one.
    expect(resolveEasyTag("@old_name#2222", members)).toBe("222222222222222222");
  });

  it("answers null when a full tag is ambiguous", () => {
    // Two members whose ids end in the same four digits, and a tag whose
    // name matches neither: the tag cannot be resolved.
    const ambiguous = [
      member("123456789012345444", "delta"),
      member("987654321098765444", "echo"),
    ];

    expect(resolveEasyTag("@wrong_name#4444", ambiguous)).toBeNull();
  });

  it("resolves a bare name by the username", () => {
    expect(resolveEasyTag("@charlie", members)).toBe("333333333333333333");
  });

  it("resolves a bare name by the display name", () => {
    const withDisplay = [member("111111111111111111", "a", "Alpha")];

    expect(resolveEasyTag("@alpha", withDisplay)).toBe("111111111111111111");
  });

  it("resolves a bare name without the `@`", () => {
    expect(resolveEasyTag("bravo", members)).toBe("222222222222222222");
  });

  it("answers null for a tag that refers to nobody", () => {
    expect(resolveEasyTag("@nobody", members)).toBeNull();
  });

  it("answers null for an id that is not in the guild", () => {
    expect(resolveEasyTag("999999999999999999", members)).toBeNull();
  });

  it("answers null for an empty tag", () => {
    expect(resolveEasyTag("@", members)).toBeNull();
  });
});

describe("the messages", () => {
  it("advertises the full tag", () => {
    // The wording is kept, and it is the wording that made the source bug
    // visible: it promises a form the source could not read.
    expect(NO_TAG_MESSAGE).toContain("@their_full_discord_tag");
  });

  it("shows the original content and the mentions it resolved", () => {
    const reply = buildEasyTagReply("hi @alpha#1111", ["<@111111111111111111>"]);

    expect(reply).toContain("hi @alpha#1111");
    expect(reply).toContain("<@111111111111111111>");
  });
});
