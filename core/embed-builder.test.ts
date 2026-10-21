/**
 * The embed designer, and the owner of the draft.
 *
 * The select that drives the designer carries the draft's token, and the
 * token is in the message — so the message is in a channel other people
 * can read, and the token is not a secret. The draft remembers who
 * started it, and that is what stops somebody else from driving it.
 */

import { describe, expect, it } from "vitest";
import { EmbedDesigner } from "./embed-builder.js";
import { fakeInteraction } from "./interaction.fake.js";

/** A draft that is never touched. */
function designer(): EmbedDesigner {
  return new EmbedDesigner();
}

describe("the draft's owner", () => {
  it("knows who started the draft", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    expect(embeds.ownerOf(token)).toBe("owner-1");
    expect(embeds.isOwner(token, "owner-1")).toBe(true);
    expect(embeds.isOwner(token, "someone-else")).toBe(false);
  });

  it("knows nobody owns a token the store has forgotten", () => {
    const embeds = designer();

    // A token that was never issued — or one whose draft has expired —
    // is nobody's draft.
    expect(embeds.ownerOf("not-a-token")).toBeUndefined();
    expect(embeds.isOwner("not-a-token", "owner-1")).toBe(false);
  });

  it("keeps the owner when the draft is edited", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const next = embeds.apply("main", token, {
      title: "House rules",
      description: "Be nice.",
    });

    expect(next?.title).toBe("House rules");
    expect(embeds.ownerOf(token)).toBe("owner-1");
    expect(embeds.read(token)?.description).toBe("Be nice.");
  });
});

describe("the owner's check", () => {
  it("lets the owner through", async () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");
    const { interaction, reply } = fakeInteraction({ userId: "owner-1" });

    const allowed = await embeds.guardOwner(interaction, token);

    expect(allowed).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

  it("refuses a member who does not own the draft", async () => {
    // The case the check exists for: the token is in the message, so
    // anybody in the channel can press the select that carries it.
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");
    const { interaction, reply } = fakeInteraction({
      userId: "someone-else",
    });

    const allowed = await embeds.guardOwner(interaction, token);

    expect(allowed).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("refuses a draft that is gone", async () => {
    const embeds = designer();
    const { interaction, reply } = fakeInteraction({ userId: "owner-1" });

    const allowed = await embeds.guardOwner(interaction, "not-a-token");

    expect(allowed).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe("the designer's custom ids", () => {
  it("carries the draft's token in the select's custom id", () => {
    // The area has to be able to tell which draft a press is for, or it
    // cannot ask who owns it.
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const customId = embeds.buildOptions(token).toJSON().custom_id;

    expect(customId).toContain(token);
  });

  it("carries the draft's token in the modal's custom id", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const customId = embeds.buildModal("main", token).toJSON().custom_id;

    expect(customId).toContain(token);
  });
});
