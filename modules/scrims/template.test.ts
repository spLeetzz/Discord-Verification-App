import { describe, expect, it } from "vitest";

import {
  applyKeywords,
  isEmptyTemplate,
  parseTemplate,
  substituteKeywords,
} from "./template.js";
import {
  CLOSE_MESSAGE_KEYWORDS,
  OPEN_MESSAGE_KEYWORDS,
  SLOTLIST_KEYWORDS,
} from "./template.js";

describe("the keyword substitution", () => {
  it("replaces every occurrence of a keyword", () => {
    const text = "<<slots>> slots and <<slots>> more slots";

    expect(substituteKeywords(text, { slots: "12" })).toBe(
      "12 slots and 12 more slots",
    );
  });

  it("leaves an unknown keyword alone", () => {
    expect(substituteKeywords("<<nope>>", { slots: "12" })).toBe("<<nope>>");
  });

  it("does not touch a keyword whose value is missing", () => {
    expect(substituteKeywords("<<slots>>", {})).toBe("<<slots>>");
  });

  it("does not mistake a keyword prefix for a keyword", () => {
    expect(substituteKeywords("<<slots>>x", { slots: "1" })).toBe("1x");
    expect(substituteKeywords("<<slot>>", { slots: "1" })).toBe("<<slot>>");
  });
});

describe("applying keywords to a template", () => {
  const template = {
    title: "<<name>> slotlist",
    description: "```\n<<slots>>\n```",
    fields: [
      { name: "Taken in <<time_taken>>", value: "at <<open_time>>" },
    ],
    footer: { text: "<<name>>" },
  };

  it("substitutes in the title, the description, the fields and the footer", () => {
    const result = applyKeywords(template, {
      name: "Quotient",
      slots: "Slot 01 -> Team A",
      time_taken: "2 hours",
      open_time: "tomorrow",
    });

    expect(result.title).toBe("Quotient slotlist");
    expect(result.description).toBe("```\nSlot 01 -> Team A\n```");
    expect(result.fields?.[0]?.name).toBe("Taken in 2 hours");
    expect(result.fields?.[0]?.value).toBe("at tomorrow");
    expect(result.footer?.text).toBe("Quotient");
  });

  it("leaves a field's inline flag alone", () => {
    const result = applyKeywords(
      { fields: [{ name: "a", value: "b", inline: true }] },
      {},
    );

    expect(result.fields?.[0]?.inline).toBe(true);
  });
});

describe("reading a stored template", () => {
  it("reads a well-formed template", () => {
    const parsed = parseTemplate({
      title: "hi",
      description: "there",
      color: 255,
      fields: [{ name: "a", value: "b", inline: true }],
      footer: { text: "f" },
    });

    expect(parsed.title).toBe("hi");
    expect(parsed.color).toBe(255);
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.footer?.text).toBe("f");
  });

  it("survives a malformed value instead of crashing a render", () => {
    // D32: the source re-parsed a Python literal on every render, so any
    // other code path writing the column crashed the next render.
    expect(parseTemplate(null)).toEqual({});
    expect(parseTemplate("not an object")).toEqual({});
    expect(parseTemplate({ title: 12 })).toEqual({});
    expect(parseTemplate({ fields: "nope" })).toEqual({});
    expect(parseTemplate({ fields: [{ name: "a" }] })).toEqual({});
  });

  it("knows when a template holds no content", () => {
    // The source asked `len(template) <= 1`, which was a proxy for "the
    // template holds no content" — it worked because discord.py's
    // `Embed.to_dict()` always carried a `type: 'rich'` key. Ours is
    // `jsonb` and does not, so the question is asked directly.
    expect(isEmptyTemplate({})).toBe(true);
    expect(isEmptyTemplate({ title: "x" })).toBe(false);
    expect(isEmptyTemplate({ description: "y" })).toBe(false);
    expect(isEmptyTemplate({ fields: [{ name: "a", value: "b" }] })).toBe(false);
    expect(isEmptyTemplate({ footer: { text: "f" } })).toBe(false);
  });
});

describe("the keyword sets", () => {
  it("carries the open message keywords", () => {
    expect(OPEN_MESSAGE_KEYWORDS).toEqual([
      "mentions",
      "slots",
      "reserved",
      "slotlist",
      "multireg",
      "teamname",
      "mention_banned",
      "mention_reserved",
    ]);
  });

  it("carries the close message keywords", () => {
    expect(CLOSE_MESSAGE_KEYWORDS).toEqual([
      "slots",
      "filled",
      "time_taken",
      "open_time",
    ]);
  });

  it("carries the slotlist keywords", () => {
    expect(SLOTLIST_KEYWORDS).toEqual([
      "name",
      "time_taken",
      "open_time",
      "slots",
    ]);
  });
});
