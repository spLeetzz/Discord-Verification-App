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
import { ButtonStyle } from "discord.js";
import type { EmbedBuilder } from "discord.js";
import { prompt, PROMPT_CUSTOM_ID_PREFIX } from "./prompt.js";
import { fakeInteraction } from "./interaction.fake.js";

/** The payload a timeout edit carries. */
interface EmbedPayload {
  embeds: EmbedBuilder[];
}

/**
 * One button of a row, as a payload carries it.
 */
interface PayloadButton {
  readonly label?: string;
  readonly style?: number;
  readonly custom_id?: string;
  readonly disabled?: boolean;
}

/**
 * The buttons of the first row a payload carries.
 */
function payloadButtons(payload: unknown): readonly PayloadButton[] {
  const rows =
    (
      payload as {
        components?: readonly {
          toJSON: () => { components?: readonly PayloadButton[] };
        }[];
      }
    ).components ?? [];

  return rows[0]?.toJSON().components ?? [];
}

/**
 * The embed a payload carries.
 */
function payloadEmbed(payload: unknown): ReturnType<EmbedBuilder["toJSON"]> {
  const embeds = (payload as { embeds?: readonly EmbedBuilder[] }).embeds ?? [];

  return embeds[0]?.toJSON() ?? {};
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

describe("the prompt's appearance", () => {
  it("asks the question under a short title", async () => {
    // The prompt is the bot's most-used dialog, so it is the same
    // everywhere: a title that says what kind of thing it is, the
    // question under it, and the hint in the footer.
    const { interaction, sent } = fakeInteraction();

    await prompt(interaction, "Delete the slotlist?");

    const embed = payloadEmbed(sent[0]?.payload);

    expect(embed.title).toBe("Confirm");
    expect(embed.description).toBe("Delete the slotlist?");
    expect(embed.footer?.text).toBe("Confirm to go ahead, or cancel to stop.");
  });

  it("offers a green Confirm and a grey Cancel", async () => {
    // Green confirms, grey does everything else. A red Cancel would
    // say the cancel destroys something, and it does not.
    const { interaction, sent } = fakeInteraction();

    await prompt(interaction, "Delete the slotlist?");

    const buttons = payloadButtons(sent[0]?.payload);

    expect(buttons.map((button) => button.label)).toEqual([
      "Confirm",
      "Cancel",
    ]);
    expect(buttons[0]?.style).toBe(ButtonStyle.Success);
    expect(buttons[1]?.style).toBe(ButtonStyle.Secondary);
  });

  it("keeps the collector's custom ids on the buttons", async () => {
    // The buttons are answered by a collector, so the ids carry the
    // collector's prefix and the token. They are the router's contract
    // and they do not change.
    const { interaction, sent } = fakeInteraction();

    await prompt(interaction, "Delete the slotlist?");

    const buttons = payloadButtons(sent[0]?.payload);

    expect(buttons).toHaveLength(2);

    for (const button of buttons) {
      expect(button.custom_id).toMatch(
        new RegExp(
          `^${PROMPT_CUSTOM_ID_PREFIX}:[A-Za-z0-9_-]+:(confirm|cancel)$`,
        ),
      );
    }
  });

  it("says what happened when it is answered", async () => {
    // The question stays on the panel, so the answer can be read in
    // context.
    const { interaction, sent } = fakeInteraction();

    await prompt(interaction, "Delete the slotlist?");

    const update = sent[0]?.handle.clicks[0]?.update;
    const embed = payloadEmbed(update?.mock.calls[0]?.[0]);

    expect(embed.title).toBe("Confirmed");
    expect(embed.description).toBe("Delete the slotlist?");
  });

  it("names the timeout in the title", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }],
    });

    await prompt(interaction, "Delete the slotlist?", { timeoutMs: 20 });

    const payload = sent[0]?.handle.edit.mock.calls[0]?.[0];
    const embed = payloadEmbed(payload);

    expect(embed.title).toBe("Timed out");
    expect(embed.description).toContain("timed out");
  });
});
