import { describe, expect, it } from "vitest";

import { normaliseText } from "./text.js";

/**
 * What Quotient did to the OCR text before comparing it with anything:
 *
 *     text.lower().replace(" ", "").replace("\n", "")
 */
function quotientLowerText(raw: string): string {
  return raw.toLowerCase().replace(/ /g, "").replace(/\n/g, "");
}

describe("normaliseText", () => {
  it("lowercases the text", () => {
    expect(normaliseText("HELLO")).toBe("hello");
    expect(normaliseText("MiXeD CaSe")).toBe("mixedcase");
  });

  it("removes the spaces between the words", () => {
    expect(normaliseText("Some Channel Name")).toBe("somechannelname");
  });

  it("removes the newlines", () => {
    expect(normaliseText("first\nsecond")).toBe("firstsecond");
    expect(normaliseText("first\nsecond\nthird")).toBe("firstsecondthird");
  });

  it("agrees with Quotient's lower_text", () => {
    const samples = [
      "",
      "hello",
      "Some Channel Name",
      "line one\nline two",
      "  padded  ",
      "MiXeD\nCaSe 123",
      "#general-chat",
    ];

    for (const sample of samples) {
      expect(normaliseText(sample)).toBe(quotientLowerText(sample));
    }
  });

  it("removes the carriage return of a CRLF line ending as well", () => {
    // Quotient left the carriage return in, which splits a word in half
    // and makes a keyword check fail for the wrong reason.
    expect(normaliseText("first\r\nsecond")).toBe("firstsecond");
  });

  it("removes tabs", () => {
    expect(normaliseText("first\tsecond")).toBe("firstsecond");
  });

  it("leaves the rest of the text alone", () => {
    expect(normaliseText("subscribe-now!")).toBe("subscribe-now!");
    expect(normaliseText("100% done")).toBe("100%done");
  });

  it("returns an empty string for an empty text", () => {
    expect(normaliseText("")).toBe("");
  });
});
