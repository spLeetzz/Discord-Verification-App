/**
 * The embed-tag render path.
 *
 * The source stored `discord.Embed.to_dict()` as a **Python literal
 * string** and re-parsed it with `ast.literal_eval` on every use. Any
 * other code path that wrote the column crashed the next render — and a
 * Python literal is not JSON, so the two are not interchangeable.
 *
 * The port stores **JSON** (D32) and renders it with
 * `core/embed-builder.ts`. This test pins down that path, and the
 * malformed case: a template that does not parse has to be a refusal,
 * not a crash.
 */

import { describe, expect, it } from "vitest";
import { embedTemplateToBuilder } from "../../core/embed-builder.js";
import { buildTagBody, renderTagBody } from "./rules.js";

describe("buildTagBody", () => {
  it("stores a plain-text body as it is", () => {
    const body = buildTagBody("Be nice.", false);

    expect(body).toEqual({ body: "Be nice.", isEmbed: false });
  });

  it("stores an embed body as JSON, not a Python literal", () => {
    const body = buildTagBody(
      JSON.stringify({ title: "Rules", description: "Be nice." }),
      true,
    );

    expect(body.isEmbed).toBe(true);
    expect(JSON.parse(body.body)).toEqual({
      title: "Rules",
      description: "Be nice.",
    });

    // A Python literal would not be JSON. This is the difference that
    // matters: the value is parsed with `JSON.parse` and nothing else.
    expect(() => JSON.parse(body.body)).not.toThrow();
  });

  it("refuses a body that is too long", () => {
    expect(() => buildTagBody("a".repeat(1991), false)).toThrow();
  });

  it("refuses an embed template that is not JSON", () => {
    expect(() => buildTagBody("{'title': 'Rules'}", true)).toThrow();
  });

  it("refuses an embed template that is not an object", () => {
    expect(() => buildTagBody("[1, 2, 3]", true)).toThrow();
    expect(() => buildTagBody("\"just a string\"", true)).toThrow();
  });
});

describe("renderTagBody", () => {
  it("renders a plain-text tag as text", () => {
    const render = renderTagBody({ content: "Be nice.", isEmbed: false });

    expect(render.kind).toBe("text");
  });

  it("renders an embed tag as an embed", () => {
    const body = buildTagBody(
      JSON.stringify({
        title: "Rules",
        description: "Be nice.",
        color: 123,
        footerText: "the server",
      }),
      true,
    );

    const render = renderTagBody({ content: body.body, isEmbed: true });

    expect(render.kind).toBe("embed");

    if (render.kind !== "embed") return;

    const embed = embedTemplateToBuilder(render.template);

    expect(embed.data.title).toBe("Rules");
    expect(embed.data.description).toBe("Be nice.");
    expect(embed.data.color).toBe(123);
    expect(embed.data.footer?.text).toBe("the server");
  });

  it("refuses a malformed stored template instead of crashing", () => {
    // The source would have raised a `SyntaxError` here.
    const render = renderTagBody({
      content: "{'title': 'Rules', 'description': 'Be nice.'}",
      isEmbed: true,
    });

    expect(render.kind).toBe("broken");
    expect(render.kind === "broken" && render.reason).toContain("broken");
  });

  it("refuses an empty stored template", () => {
    const render = renderTagBody({ content: "", isEmbed: true });

    expect(render.kind).toBe("broken");
  });

  it("refuses a stored template that is not an object", () => {
    const render = renderTagBody({ content: "[1, 2, 3]", isEmbed: true });

    expect(render.kind).toBe("broken");
  });

  it("ignores the fields it does not know", () => {
    const body = buildTagBody(
      JSON.stringify({ title: "Rules", somethingElse: 42 }),
      true,
    );

    const render = renderTagBody({ content: body.body, isEmbed: true });

    expect(render.kind).toBe("embed");
  });
});
