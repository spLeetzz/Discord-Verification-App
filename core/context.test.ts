/**
 * The one place that knows about the deferred/replied distinction.
 *
 * Discord allows an interaction to be replied to **once**, so there are
 * three states and three answers: a fresh interaction replies, a
 * deferred one is edited, and one that has already answered follows up.
 */

import { describe, expect, it } from "vitest";
import { MessageFlags } from "discord.js";
import { respond, sendCollectable } from "./context.js";
import { fakeInteraction } from "./interaction.fake.js";

describe("respond", () => {
  it("replies when the interaction is fresh", async () => {
    const { interaction, reply, editReply, followUp } = fakeInteraction();

    await respond(interaction, { content: "hello" });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("edits the deferral when the interaction is deferred", async () => {
    const { interaction, reply, editReply, followUp } = fakeInteraction({
      deferred: true,
    });

    await respond(interaction, { content: "hello" });

    expect(editReply).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("follows up when the interaction has already answered", async () => {
    const { interaction, reply, editReply, followUp } = fakeInteraction({
      replied: true,
    });

    await respond(interaction, { content: "hello" });

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("does not throw on an already-replied interaction", async () => {
    // The bug this fixes: `interaction.reply()` throws once the
    // interaction has answered.
    const { interaction, reply } = fakeInteraction({ replied: true });

    await expect(
      respond(interaction, { content: "hello" }),
    ).resolves.toBeDefined();

    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps the ephemeral flag on a follow-up", async () => {
    // A follow-up is a message of its own, so it can be ephemeral even
    // when the interaction's reply was not.
    const { interaction, followUp } = fakeInteraction({ replied: true });

    await respond(interaction, { content: "hello" }, true);

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});

describe("sendCollectable", () => {
  it("replies when no follow-up was asked for", async () => {
    const { interaction, reply, followUp } = fakeInteraction();

    await sendCollectable(interaction, { content: "hello" });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
  });

  it("follows up when the interaction has already answered", async () => {
    const { interaction, reply, followUp } = fakeInteraction({
      replied: true,
    });

    await sendCollectable(interaction, { content: "hello" }, {
      asFollowUp: true,
    });

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("falls back to the reply when there is nothing to follow up on", async () => {
    // A follow-up needs an interaction that has already answered, and a
    // fresh one has not. The flow still works; it just gets one message.
    const { interaction, reply, followUp } = fakeInteraction();

    await sendCollectable(interaction, { content: "hello" }, {
      asFollowUp: true,
    });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
  });
});
