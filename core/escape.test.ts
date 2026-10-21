import { describe, expect, it } from "vitest";
import { escapeMarkdown, escapeMentions } from "./escape.js";

const ZWSP = "\u200b";

describe("escapeMarkdown", () => {
  it("escapes the bold markers", () => {
    expect(escapeMarkdown("**bold**")).toBe("\\*\\*bold\\*\\*");
  });

  it("escapes the italic markers", () => {
    expect(escapeMarkdown("_italic_")).toBe("\\_italic\\_");
  });

  it("escapes the strikethrough markers", () => {
    expect(escapeMarkdown("~~gone~~")).toBe("\\~\\~gone\\~\\~");
  });

  it("escapes the code markers", () => {
    expect(escapeMarkdown("`code`")).toBe("\\`code\\`");
  });

  it("escapes the table pipe", () => {
    expect(escapeMarkdown("a|b")).toBe("a\\|b");
  });

  it("escapes a backslash", () => {
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
  });

  it("escapes a block quote", () => {
    expect(escapeMarkdown("> quoted")).toBe("\\> quoted");
  });

  it("leaves a URL alone", () => {
    expect(escapeMarkdown("https://example.com/a_b_c")).toBe(
      "https://example.com/a_b_c",
    );
  });

  it("escapes a URL when it is asked to", () => {
    expect(escapeMarkdown("https://example.com/a_b", { ignoreLinks: false })).toBe(
      "https://example.com/a\\_b",
    );
  });

  it("escapes only the opening marker when asked to escape as needed", () => {
    expect(escapeMarkdown("**bold**", { asNeeded: true })).toBe(
      "\\*\\*bold**",
    );
  });
});

describe("escapeMentions", () => {
  it("stops @everyone from pinging", () => {
    expect(escapeMentions("@everyone")).toBe(`@${ZWSP}everyone`);
  });

  it("stops @here from pinging", () => {
    expect(escapeMentions("@here")).toBe(`@${ZWSP}here`);
  });

  it("stops a bare user id from pinging", () => {
    expect(escapeMentions("@123456789012345678")).toBe(
      `@${ZWSP}123456789012345678`,
    );
  });

  it("stops a user mention from pinging", () => {
    expect(escapeMentions("<@123456789012345678>")).not.toBe(
      "<@123456789012345678>",
    );
  });

  it("stops a role mention from pinging", () => {
    expect(escapeMentions("<@&123456789012345678>")).toContain(ZWSP);
  });

  it("stops a channel mention from pinging", () => {
    expect(escapeMentions("<#123456789012345678>")).toBe(
      "\\<#123456789012345678>",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeMentions("nothing to see here")).toBe("nothing to see here");
  });
});
