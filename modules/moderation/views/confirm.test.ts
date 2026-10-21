/**
 * The confirmation panel.
 *
 * The interesting cases are the ones the shared prompt has too: only the
 * member who opened the question may answer it, and a question nobody
 * answers is a refusal.
 *
 * The look is worth a test as well. The destructive button is alone on
 * the first row, and the grey **Cancel** has the last row to itself —
 * that is the rule the whole area rests on, and a refactor that quietly
 * moved the buttons onto one row would take it away.
 */

import { describe, expect, it } from "vitest";
import { ButtonStyle, ComponentType } from "discord.js";
import { COLLECTOR_CUSTOM_ID_PREFIX } from "../../../core/custom-id.js";
import { fakeInteraction } from "../../../core/interaction.fake.js";
import { confirmAction } from "./confirm.js";

/** One button, as plain data. */
interface ButtonData {
  readonly type: number;
  readonly style: number;
  readonly label: string;
  readonly custom_id: string;
}

/** The rows of a payload, as plain data. */
function rowsOf(payload: unknown): { readonly components: ButtonData[] }[] {
  const rows = (payload as { components?: unknown[] }).components ?? [];

  return (rows as { toJSON(): { components: ButtonData[] } }[]).map((row) =>
    row.toJSON(),
  );
}

/** A question that destroys something. */
const destructive = {
  title: "Lock channel",
  question: "Members will not be able to post in **#general**.",
  kind: "destructive" as const,
  confirmLabel: "Lock channel",
  footer: "The channel stays locked until `/unlock`.",
};

describe("the confirmation panel", () => {
  it("puts the destructive button alone on the first row", async () => {
    const { interaction, sent } = fakeInteraction();

    await confirmAction(interaction, destructive);

    const rows = rowsOf(sent[0]?.payload);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.components).toHaveLength(1);
    expect(rows[1]?.components).toHaveLength(1);
  });

  it("makes the destructive button red and the cancel grey", async () => {
    const { interaction, sent } = fakeInteraction();

    await confirmAction(interaction, destructive);

    const rows = rowsOf(sent[0]?.payload);
    const confirm = rows[0]?.components[0];
    const cancel = rows[1]?.components[0];

    expect(confirm?.style).toBe(ButtonStyle.Danger);
    expect(confirm?.label).toBe("Lock channel");
    expect(cancel?.style).toBe(ButtonStyle.Secondary);
    expect(cancel?.label).toBe("Cancel");
  });

  it("makes a question that creates something green", async () => {
    const { interaction, sent } = fakeInteraction();

    await confirmAction(interaction, {
      ...destructive,
      kind: "constructive",
      confirmLabel: "Create channels",
    });

    const rows = rowsOf(sent[0]?.payload);

    expect(rows[0]?.components[0]?.style).toBe(ButtonStyle.Success);
  });

  it("keeps the custom id in the collector's namespace", async () => {
    // The router leaves a collector's interaction alone. An id outside
    // that namespace would be refused as one nobody owns, and the
    // collector would never see the answer.
    const { interaction, sent } = fakeInteraction();

    await confirmAction(interaction, destructive);

    const rows = rowsOf(sent[0]?.payload);

    for (const row of rows) {
      for (const button of row.components) {
        expect(button.custom_id.startsWith(COLLECTOR_CUSTOM_ID_PREFIX)).toBe(
          true,
        );
      }
    }
  });

  it("asks the moderator", async () => {
    const { interaction, sent } = fakeInteraction();

    const confirmed = await confirmAction(interaction, destructive);

    expect(confirmed).toBe(true);
    expect(sent[0]?.method).toBe("reply");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("ignores another member's click and keeps waiting for the moderator", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }, { userId: "owner" }],
    });

    const confirmed = await confirmAction(interaction, destructive);

    expect(confirmed).toBe(true);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("refuses when nobody answers", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else" }],
    });

    const confirmed = await confirmAction(interaction, {
      ...destructive,
      timeoutMs: 20,
    });

    expect(confirmed).toBe(false);
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
  });

  it("puts the second question of a flow on a follow-up", async () => {
    // An interaction can only be answered once, so a flow that asks twice
    // puts the second question on a follow-up.
    const { interaction, sent, followUp, reply } = fakeInteraction({
      replied: true,
    });

    await confirmAction(interaction, destructive);

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("followUp");
  });

  it("collects on the button kind it asked for", async () => {
    const { interaction, sent } = fakeInteraction();

    await confirmAction(interaction, destructive);

    const collector = sent[0]?.handle.awaitMessageComponent.mock.calls[0]?.[0];

    expect(collector?.componentType).toBe(ComponentType.Button);
  });
});
