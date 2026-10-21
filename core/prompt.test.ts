/**
 * The Confirm/Cancel row.
 *
 * The interesting case is the second one: an interaction can only be
 * replied to once, so a flow that asks twice puts the second question on
 * a follow-up.
 *
 * The other interesting case is the owner: the prompt belongs to the
 * member who opened it, so somebody else's click is not an answer.
 */

import { describe, expect, it } from "vitest";
import type { EmbedBuilder } from "discord.js";
import { prompt } from "./prompt.js";
import { fakeInteraction } from "./interaction.fake.js";

/** The payload a timeout edit carries. */
interface EmbedPayload {
  embeds: EmbedBuilder[];
}

describe("prompt", () => {
  it("collects on the interaction's own reply", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction();

    const confirmed = await prompt(interaction, "Delete the slotlist?");

    expect(confirmed).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("reply");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("collects on the follow-up when the flow asks twice", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      replied: true,
    });

    const confirmed = await prompt(interaction, "Delete the slotlist?", {
      asFollowUp: true,
    });

    expect(confirmed).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("followUp");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("falls back to the reply when there is nothing to follow up on", async () => {
    const { interaction, reply, followUp } = fakeInteraction();

    const confirmed = await prompt(interaction, "Delete the slotlist?", {
      asFollowUp: true,
    });

    expect(confirmed).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
  });
});

describe("the prompt's owner", () => {
  it("lets the owner answer", async () => {
    const { interaction, sent } = fakeInteraction({ userId: "owner" });

    const confirmed = await prompt(interaction, "Delete the slotlist?");

    expect(confirmed).toBe(true);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });

  it("ignores another member's click and keeps waiting for the owner", async () => {
    // The token in the custom id is in the message, and the message is in
    // a channel other people can read — so the owner check has to be on
    // the user. The other member's click is not an answer: the prompt
    // stays open, and the owner can still answer it.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }, { userId: "owner" }],
    });

    const confirmed = await prompt(interaction, "Delete the slotlist?");

    expect(confirmed).toBe(true);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();
    expect(clicks[1]?.userId).toBe("owner");
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("times out when only another member clicks", async () => {
    // The case that matters: the other member's click must not answer the
    // prompt. It is refused, the prompt keeps waiting, and it ends as a
    // timeout — a refusal.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }],
    });

    const confirmed = await prompt(interaction, "Delete the slotlist?", {
      timeoutMs: 20,
    });

    expect(confirmed).toBe(false);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();

    // The prompt waited for its timeout and closed itself down.
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);

    const payload = sent[0]?.handle.edit.mock.calls[0]?.[0] as EmbedPayload;

    expect(payload.embeds[0]?.toJSON().description).toContain("timed out");
  });

  it("lets another member answer when the caller opts in", async () => {
    // The opt-out is deliberate and visible: a prompt that anyone may
    // answer has to say so.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }],
    });

    const confirmed = await prompt(interaction, "Who wants the next slot?", {
      allowOthers: true,
    });

    expect(confirmed).toBe(true);
    expect(sent[0]?.handle.clicks[0]?.userId).toBe("someone-else");
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });
});
