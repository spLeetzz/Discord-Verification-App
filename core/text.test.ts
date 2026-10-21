import { describe, expect, it } from "vitest";
import { humanJoin, plural, titleCase, truncate } from "./text.js";

describe("truncate", () => {
  it("leaves a short string alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("cuts a long string and adds the suffix", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("never returns more than the limit", () => {
    const result = truncate("x".repeat(200), 20);

    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("does not cut a string that already fits", () => {
    // Quotient's version always cut `len(suffix)` characters off, so a
    // 127 character name in a 128 character field came out as 125.
    expect(truncate("x".repeat(127), 128)).toBe("x".repeat(127));
  });

  it("returns an empty string for a limit of zero or less", () => {
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello", -1)).toBe("");
  });
});

describe("plural", () => {
  it("uses the singular for one", () => {
    expect(plural(1, "day")).toBe("1 day");
  });

  it("uses the plural for anything else", () => {
    expect(plural(3, "day")).toBe("3 days");
    expect(plural(0, "day")).toBe("0 days");
  });

  it("uses the singular for minus one, as Quotient did", () => {
    // Quotient compared `abs(v) != 1`.
    expect(plural(-1, "day")).toBe("-1 day");
  });

  it("accepts an irregular plural", () => {
    expect(plural(2, "box", "boxes")).toBe("2 boxes");
  });
});

describe("humanJoin", () => {
  it("returns an empty string for an empty list", () => {
    expect(humanJoin([])).toBe("");
  });

  it("returns the only item", () => {
    expect(humanJoin(["a"])).toBe("a");
  });

  it("uses the final word for two items", () => {
    expect(humanJoin(["a", "b"])).toBe("a or b");
  });

  it("uses a comma and the final word for three", () => {
    expect(humanJoin(["a", "b", "c"])).toBe("a, b or c");
  });

  it("takes a custom final word", () => {
    expect(humanJoin(["a", "b", "c"], ", ", "and")).toBe("a, b and c");
  });
});

describe("titleCase", () => {
  it("upper-cases the first letter of every word", () => {
    expect(titleCase("hello world")).toBe("Hello World");
  });

  it("lower-cases the rest of the word", () => {
    expect(titleCase("HELLO WORLD")).toBe("Hello World");
  });

  it("breaks words at non-letters", () => {
    expect(titleCase("abc123def")).toBe("Abc123Def");
  });

  it("treats an apostrophe as a word break, like Python's title()", () => {
    expect(titleCase("don't")).toBe("Don'T");
  });

  it("leaves a character alone when upper-casing would change its length", () => {
    // Python's title-casing never expands one character into several.
    expect(titleCase("straße")).toBe("Straße");
  });
});
