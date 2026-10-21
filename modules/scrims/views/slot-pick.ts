/**
 * The slotlist editor's "pick a slot" menu.
 *
 * **Why this menu is persistent.** Discord lets an interaction do
 * exactly one thing: reply, defer, update or show a modal. The
 * `awaitSelect` in `core/select.ts` *answers* the select interaction it
 * opens — that is how it collects the value — so a menu that is waited
 * on inline cannot be followed by a modal. `showModal` on an answered
 * interaction is a hard error, and the "Add Team" and "Change Team"
 * flows both need a modal after the choice.
 *
 * So the choice is made with a **persistent** menu: a real component in
 * a message, whose answer arrives as an interaction of its own, still
 * unanswered, so the modal can be shown from it. The tourneys area
 * solves the same problem the same way (`views/select-handlers.ts`).
 *
 * **The menu lives on the panel's own message.** The pick is then an
 * interaction *on the panel*, and the modal that follows is opened from
 * it — so the modal submit's message is the panel, and the panel is
 * re-rendered in place. A menu in a message of its own would leave the
 * panel behind on a different message.
 *
 * **The custom id carries who asked.**
 *
 * ```
 * scrims:slotm_pick:<scrimId>:<kind>:<userId>
 * ```
 *
 * The menu is dispatched by custom id through the router, and the router
 * has no owner check of its own — so the handler compares the member
 * with the id and refuses a pick from anybody else. The tourneys area
 * encodes the member the same way (`tourneys:slotm_pick:<tourneyId>:
 * <userId>`).
 *
 * The **slot** the member picked travels as the menu's value, and the
 * modal's token carries it — together with the scrim and the member —
 * so the submit handler knows exactly what it is for.
 */

import { StringSelectMenuBuilder } from "discord.js";
import type { AnySelectMenuInteraction, ButtonInteraction } from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import * as repo from "../repo.js";
import type { ScrimRecord, SlotRecord } from "../types.js";
import { buildModal, selectRow } from "./components.js";
import { fail } from "./handlers.js";
import { scrimsId } from "./ids.js";
import { buildSlotlistEditorPanel } from "./panels.js";
import type { PanelComponents } from "./manager.js";

/**
 * Which team flow a pick belongs to.
 *
 * "add" offers the scrim's free slots, "change" its claimed ones. The
 * two share the modal: the submit handler looks at the slot's state to
 * decide whether to claim it or to replace its team.
 */
export type SlotPickKind = "add" | "change";

/** The kinds a pick menu can be. */
const SLOT_PICK_KINDS: readonly SlotPickKind[] = ["add", "change"];

/** Narrows a custom-id part to a kind. */
function isSlotPickKind(value: string): value is SlotPickKind {
  return (SLOT_PICK_KINDS as readonly string[]).includes(value);
}

/** How long a pick stays open. */
const PICK_TTL_MS = 10 * 60_000;

/**
 * The state a pick carries into the modal.
 *
 * It is the three things the flow needs and cannot look up: which
 * scrim, which slot, and whose answer it is.
 */
export interface SlotSelection {
  readonly scrimId: string;
  readonly slotId: string;
  /** The member who opened the menu. */
  readonly userId: string;
}

/** The picks in flight. */
const slotSelections = new TokenStore<SlotSelection>({ ttlMs: PICK_TTL_MS });

/**
 * Issues the token the modal carries.
 *
 * The modal's custom id is `scrims:modal:slot_team:<token>`; the token
 * points at the state the pick collected.
 */
export function issueSlotSelection(selection: SlotSelection): string {
  return slotSelections.issue(selection);
}

/**
 * Takes the state a modal carries.
 *
 * One-shot: a second submit finds nothing and is refused.
 *
 * @returns the state, or `null` when the token is unknown or has
 *          expired.
 */
export function takeSlotSelection(token: string): SlotSelection | null {
  return slotSelections.take(token) ?? null;
}

/**
 * Shows the "pick a slot" menu on the panel's own message.
 *
 * The button press is answered with the edit: the panel keeps its
 * buttons and gains the menu. The menu is answered by a *later*
 * interaction — the pick — which is what leaves the modal possible.
 *
 * **Where the menu lands depends on what the button press has already
 * done.** A fresh press edits the panel's own message, and a deferred
 * one edits it as well; a press that has already answered can only put
 * the menu in a message of its own, as a follow-up. The flow is the
 * same either way — the pick is answered by its own custom id.
 *
 * @param slots the slots on offer — the free ones for "add", the
 *              claimed ones for "change".
 */
export async function openSlotPicker(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
  slots: readonly SlotRecord[],
  kind: SlotPickKind,
): Promise<void> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(scrimsId("slotm_pick", scrim.id, kind, interaction.user.id))
    .setPlaceholder(
      kind === "add"
        ? "Select the slot to add a team to"
        : "Select the slot to change",
    )
    .setMinValues(1)
    .setMaxValues(1);

  for (const slot of slots.slice(0, 25)) {
    menu.addOptions({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
    });
  }

  const panel = buildSlotlistEditorPanel(scrim);

  const components: PanelComponents = [...panel.components, selectRow(menu)];

  if (interaction.replied) {
    // The press has answered already, so the panel's message cannot be
    // edited through the interaction. The menu goes in a message of its
    // own.
    await interaction.followUp({
      content:
        kind === "add"
          ? "Pick the slot to add a team to."
          : "Pick the slot to change.",
      components: [selectRow(menu)],
    });

    return;
  }

  if (interaction.deferred) {
    // A deferral is an edit of the message the button is on, so the
    // menu still lands on the panel.
    await interaction.editReply({ embeds: panel.embeds, components });

    return;
  }

  await interaction.update({ embeds: panel.embeds, components });
}

/**
 * Handles the answer to the "pick a slot" menu.
 *
 * The pick arrives as an interaction of its own, still unanswered, so
 * the modal is shown from it.
 *
 * @param parts the parts after the action: the scrim, the kind and the
 *              member who opened the menu.
 */
export async function handleSlotPick(
  interaction: AnySelectMenuInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, kind, userId] = parts;

  if (!scrimId || !kind || !userId || !isSlotPickKind(kind)) {
    await fail(interaction, "That menu is no longer active.");

    return;
  }

  // The owner check. The menu is dispatched by custom id through the
  // router, and the router has no owner check of its own: without this
  // a click from another moderator would drive the flow.
  if (interaction.user.id !== userId) {
    await fail(interaction, "That menu is not yours.");

    return;
  }

  const slotId = interaction.values[0];

  if (!slotId) {
    await fail(interaction, "No slot was picked.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const slot = await repo.getSlot(slotId);

  if (!slot || slot.scrimId !== scrim.id) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  // The slot has to be one the menu offered: a free slot for "add", a
  // claimed one for "change". A slot that changed state while the menu
  // was open is refused rather than guessed at.
  if (kind === "add" && slot.state !== "free") {
    await fail(interaction, "That slot is not free any more.");

    return;
  }

  if (kind === "change" && slot.state !== "claimed") {
    await fail(interaction, "That slot can no longer be changed.");

    return;
  }

  const token = issueSlotSelection({
    scrimId: scrim.id,
    slotId: slot.id,
    userId,
  });

  await interaction.showModal(
    buildModal({
      customId: scrimsId("modal", "slot_team", token),
      title: kind === "add" ? "Add a team" : "Change the team",
      texts: [
        {
          id: "team_name",
          label: "The team name",
          maxLength: 25,
        },
        {
          id: "leader",
          label: "The team leader (optional)",
          placeholder: "@leader",
          maxLength: 64,
        },
      ],
    }),
  );
}
