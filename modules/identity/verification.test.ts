/**
 * The screenshot-verification rules.
 *
 * The rules are checked against the text this port's OCR provider
 * actually produces: the local Tesseract provider hands back
 * `text` (lower-cased, whitespace stripped) **and** `rawText` (the text as
 * the engine read it). The contains-rules read the first, the literal
 * button checks read the second, and the page-name check reads the first
 * with the noise tolerance.
 */

import { describe, expect, it } from "vitest";
import { normaliseText } from "../ssverify/ocr/index.js";
import type { OcrResult } from "../ssverify/ocr/index.js";
import {
  hasFollowButton,
  hasSubscribeButton,
  isBoundedSubsequence,
  matchesName,
  pageLabel,
  rulesFor,
  screenshotTypeLabel,
  stripNoise,
  verifyScreenshot,
  VERIFICATION_RULES,
} from "./verification.js";
import type { VerificationConfig } from "./verification.js";

/**
 * The result the local OCR provider produces for a piece of text.
 *
 * The provider normalises the text the same way this helper does, so a
 * rule that reads `text` sees exactly what it would see in production.
 */
function ocr(rawText: string): OcrResult {
  return {
    text: normaliseText(rawText),
    dhash: "0000000000000000",
    phash: "1111111111111111",
    rawText,
  };
}

/** A YouTube setup for the "Team Phoenix" channel. */
const youtube: VerificationConfig = {
  ssType: "youtube",
  channelName: "Team Phoenix",
  channelLink: "https://youtube.com/@teamphoenix",
  keywords: [],
};

/** An Instagram setup for the "Team Phoenix" page. */
const instagram: VerificationConfig = {
  ssType: "instagram",
  channelName: "Team Phoenix",
  channelLink: "https://instagram.com/teamphoenix",
  keywords: [],
};

describe("the YouTube rules", () => {
  it("refuses a screenshot that is not of YouTube", () => {
    // Neither "subscribe" nor "videos" — the two words that say "this is
    // a YouTube screenshot".
    const result = verifyScreenshot(
      youtube,
      ocr("Team Phoenix\n1.2M followers\n12 posts"),
    );

    expect(result).toEqual({ ok: false, reason: "This is not a valid youtube ss." });
  });

  it("accepts a screenshot that shows the channel", () => {
    const result = verifyScreenshot(
      youtube,
      ocr("Team Phoenix\nSUBSCRIBED\n12 videos"),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a screenshot of another channel", () => {
    const result = verifyScreenshot(
      youtube,
      ocr("Team Sparrow\nSubscribe\n12 videos"),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Screenshot must belong to [`Team Phoenix`](https://youtube.com/@teamphoenix) channel.",
    });
  });

  it("refuses a screenshot where the subscribe button is still showing", () => {
    const result = verifyScreenshot(
      youtube,
      ocr("Team Phoenix\nSUBSCRIBE\n12 videos"),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "You must subscribe [`Team Phoenix`](https://youtube.com/@teamphoenix) to get verified.",
    });
  });

  it("accepts a screenshot where the button says subscribed", () => {
    // "SUBSCRIBED" is the member *having* subscribed, so it must not
    // trigger the refusal.
    const result = verifyScreenshot(
      youtube,
      ocr("Team Phoenix\nSUBSCRIBED\n12 videos"),
    );

    expect(result.ok).toBe(true);
  });

  it("reads the subscribe button whatever the casing is", () => {
    // Tesseract does not guarantee the casing the screen shows.
    const result = verifyScreenshot(
      youtube,
      ocr("Team Phoenix\nSubscribe\n12 videos"),
    );

    expect(result.ok).toBe(false);
  });
});

describe("the Instagram rules", () => {
  it("refuses a screenshot that is not of Instagram", () => {
    const result = verifyScreenshot(
      instagram,
      ocr("Team Phoenix\n12 posts"),
    );

    expect(result).toEqual({
      ok: false,
      reason: "This is not a valid instagram ss.",
    });
  });

  it("refuses a screenshot of another page", () => {
    const result = verifyScreenshot(
      instagram,
      ocr("Team Sparrow\n1,204 followers"),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Screenshot must belong to [`Team Phoenix`](https://instagram.com/teamphoenix) page.",
    });
  });

  it("refuses a screenshot where the follow button is still showing", () => {
    const result = verifyScreenshot(
      instagram,
      ocr("Team Phoenix\nFOLLOW\n1,204 followers"),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "You must follow [`Team Phoenix`](https://instagram.com/teamphoenix) to get verified.",
    });
  });

  it("accepts a screenshot where the button says following", () => {
    const result = verifyScreenshot(
      instagram,
      ocr("Team Phoenix\nFollowing\n1,204 followers"),
    );

    expect(result.ok).toBe(true);
  });
});

describe("the page-name check", () => {
  it("matches a name that the engine read with an icon in it", () => {
    // The engine reads an icon as punctuation often enough that the name
    // arrives as `team|phoenix` instead of `team phoenix`.
    expect(matchesName("Team Phoenix", ocr("team|phoenix").text)).toBe(true);
  });

  it("matches a name that the engine read with a character in it", () => {
    // The icon was read as a letter, so the name arrives as
    // `teamxphoenix` — the same mistake with a different character.
    expect(matchesName("Team Phoenix", ocr("teamxphoenix").text)).toBe(true);
  });

  it("does not match a name that is simply different", () => {
    expect(matchesName("Team Phoenix", ocr("team sparrow").text)).toBe(false);
  });

  it("normalises both sides the same way", () => {
    // The configured name has a space in it and the engine's text has
    // one too; both are stripped, so the two still match.
    expect(matchesName("Team Phoenix", "team phoenix")).toBe(true);
    expect(matchesName("Team  Phoenix", "teamphoenix")).toBe(true);
    expect(matchesName("TEAM PHOENIX", "team phoenix")).toBe(true);
  });

  it("matches nothing when the name is empty", () => {
    // An empty name means "any page will do", so the check is skipped.
    expect(matchesName("", "anything at all")).toBe(true);
  });

  it("strips the punctuation out of the text", () => {
    expect(stripNoise("team|phoenix")).toBe("teamphoenix");
    expect(stripNoise("team phoenix")).toBe("teamphoenix");
  });

  it("counts the noise between the matched parts", () => {
    expect(isBoundedSubsequence("teamphoenix", "teamphoenix", 0)).toBe(true);
    expect(isBoundedSubsequence("teamphoenix", "teamxphoenix", 1)).toBe(true);
    expect(isBoundedSubsequence("teamphoenix", "teamxphoenix", 0)).toBe(false);
  });

  it("needs the parts in order", () => {
    expect(isBoundedSubsequence("teamphoenix", "phoenixteam", 2)).toBe(false);
  });
});

describe("the button checks", () => {
  it("finds the subscribe button", () => {
    expect(hasSubscribeButton(ocr("SUBSCRIBE"))).toBe(true);
  });

  it("does not mistake 'subscribed' for the button", () => {
    expect(hasSubscribeButton(ocr("SUBSCRIBED"))).toBe(false);
  });

  it("finds the follow button", () => {
    expect(hasFollowButton(ocr("FOLLOW"))).toBe(true);
  });

  it("does not mistake 'following' for the button", () => {
    expect(hasFollowButton(ocr("Following"))).toBe(false);
  });

  it("does not mistake 'unfollow' for the button", () => {
    expect(hasFollowButton(ocr("Unfollow"))).toBe(false);
  });

  it("sees a button at the end of a line", () => {
    // The engine puts a button on its own line, and the trailing space
    // of Quotient's check is gone in the normalised text.
    expect(hasSubscribeButton(ocr("Team Phoenix\nSUBSCRIBE\n"))).toBe(true);
  });
});

describe("the other types", () => {
  it("checks the page and the follow button for a rooter setup", () => {
    const config: VerificationConfig = {
      ssType: "rooter",
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: [],
    };

    const accepted = verifyScreenshot(config, ocr("team phoenix"));

    expect(accepted.ok).toBe(true);

    const refused = verifyScreenshot(config, ocr("team phoenix\nFOLLOW"));

    expect(refused.ok).toBe(false);
  });

  it("checks the page and the follow button for a loco setup", () => {
    const config: VerificationConfig = {
      ssType: "loco",
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: [],
    };

    expect(verifyScreenshot(config, ocr("team phoenix")).ok).toBe(true);
  });

  it("accepts anything for an 'any screenshot' setup", () => {
    const config: VerificationConfig = {
      ssType: "any_ss",
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: [],
    };

    expect(verifyScreenshot(config, ocr("")).ok).toBe(true);
  });

  it("accepts a custom screenshot that shows the name", () => {
    const config: VerificationConfig = {
      ssType: "custom",
      channelName: "Installation Screen",
      channelLink: "",
      keywords: ["Installation Screen", "hardware"],
    };

    expect(verifyScreenshot(config, ocr("installation screen")).ok).toBe(true);
  });

  it("accepts a custom screenshot that shows one of the keywords", () => {
    const config: VerificationConfig = {
      ssType: "custom",
      channelName: "Installation Screen",
      channelLink: "",
      keywords: ["Installation Screen", "hardware"],
    };

    expect(verifyScreenshot(config, ocr("the hardware is ready")).ok).toBe(true);
  });

  it("refuses a custom screenshot that shows neither", () => {
    const config: VerificationConfig = {
      ssType: "custom",
      channelName: "Installation Screen",
      channelLink: "",
      keywords: ["Installation Screen", "hardware"],
    };

    const result = verifyScreenshot(config, ocr("a picture of a cat"));

    expect(result).toEqual({
      ok: false,
      reason: "This is not a valid Installation Screen ss.",
    });
  });

  it("names the page, not the first keyword, when it refuses", () => {
    // The keywords are rows in a table of their own, so they are a set
    // and have no first element: the refusal names the page.
    const config: VerificationConfig = {
      ssType: "custom",
      channelName: "Installation Screen",
      channelLink: "",
      keywords: ["hardware", "Installation Screen"],
    };

    const result = verifyScreenshot(config, ocr("a picture of a cat"));

    expect(result).toEqual({
      ok: false,
      reason: "This is not a valid Installation Screen ss.",
    });
  });

  it("names the keyword when the setup has no page name", () => {
    const config: VerificationConfig = {
      ssType: "custom",
      channelName: "",
      channelLink: "",
      keywords: ["Installation Screen"],
    };

    const result = verifyScreenshot(config, ocr("a picture of a cat"));

    expect(result).toEqual({
      ok: false,
      reason: "This is not a valid Installation Screen ss.",
    });
  });
});

describe("the matrix", () => {
  it("refuses an empty text", () => {
    // A broken OCR produces an empty text, and for these two types an
    // empty text is refused rather than waved through. It is not the case
    // for *every* type — `any_ss` has no rules at all — which is why the
    // submission is refused outright when the OCR is known to be off (see
    // `ocr.test.ts`).
    expect(verifyScreenshot(youtube, ocr("")).ok).toBe(false);
    expect(verifyScreenshot(instagram, ocr("")).ok).toBe(false);
  });

  it("refuses a type it does not know", () => {
    expect(() => rulesFor("tiktok" as never)).toThrow(RangeError);
  });

  it("has a rule list for every type", () => {
    for (const type of Object.keys(VERIFICATION_RULES)) {
      expect(Array.isArray(VERIFICATION_RULES[type as keyof typeof VERIFICATION_RULES])).toBe(
        true,
      );
    }
  });

  it("names the type in the setup panel", () => {
    expect(screenshotTypeLabel("any_ss")).toBe("Any Screenshot");
  });
});

describe("pageLabel", () => {
  it("makes a link when there is one", () => {
    expect(pageLabel(youtube)).toBe(
      "[`Team Phoenix`](https://youtube.com/@teamphoenix)",
    );
  });

  it("makes plain text when there is not", () => {
    expect(
      pageLabel({
        ssType: "rooter",
        channelName: "Team Phoenix",
        channelLink: "",
        keywords: [],
      }),
    ).toBe("`Team Phoenix`");
  });
});
