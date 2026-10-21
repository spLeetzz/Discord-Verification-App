/**
 * Picking a value, and then doing something with it.
 *
 * **Why this exists.** Discord lets an interaction do exactly one thing:
 * reply, defer, update, or show a modal. A select menu that is opened
 * with `core/select.ts`'s `awaitSelect` is *consumed* by that helper —
 * it acknowledges the select interaction — so a modal cannot be opened
 * from it afterwards. `showModal` after a reply is a hard error
 * ("Cannot show modal after deferring or replying to an interaction").
 *
 * Three flows need a modal *after* a choice: the claim (pick the scrim,
 * then write the team name), the punish (pick the slots, then the ban
 * mode, then write the reason) and the moderator's team forms (pick the
 * slot, then write the team name).
 *
 * So the choice is made with a **persistent** select menu whose custom id
 * carries a token. The menu's interaction is fresh when the member picks,
 * which means the handler may open the modal from it.
 *
 * The token is the ephemeral half of D18: the state of a flow that is
 * mid-flight and has no database row yet. It expires, and the menu is
 * refused politely when it does.
 */

import {
  ComponentType,
  SelectMenuOptionBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type {
  AnySelectMenuInteraction,
  RepliableInteraction,
} from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import { respond } from "../../../core/context.js";
import { run } from "../../../core/fire-and-forget.js";
import { slotsId } from "../ids.js";
import type { BanMode } from "../types.js";
import { selectRow } from "./components.js";

/** How long a pick stays open. */
const PICK_TTL_MS = 5 * 60_000;

/** How long a modal stays open. */
const MODAL_TTL_MS = 15 * 60_000;

/**
 * The state a pick carries.
 *
 * Each kind is one step of one flow. The *choice* itself travels in the
 * menu's value, not in the context — a pick menu offers several choices
 * and one token covers all of them.
 */
export type PickContext =
  | {
      readonly kind: "claim";
      readonly managerId: string;
    }
  | {
      readonly kind: "punish_slots";
      readonly scrimId: string;
    }
  | {
      readonly kind: "punish_mode";
      readonly scrimId: string;
      readonly slotIds: readonly string[];
    }
  | {
      readonly kind: "add_team";
      readonly scrimId: string;
    }
  | {
      readonly kind: "change_team";
      readonly scrimId: string;
    }
  | {
      readonly kind: "remove_team";
      readonly scrimId: string;
    }
  | {
      readonly kind: "info";
      readonly scrimId: string;
    };

/**
 * The state a modal carries.
 *
 * The modal is the last step of every flow, so its state is everything
 * the earlier steps collected.
 */
export type ModalContext =
  | {
      readonly kind: "claim";
      readonly managerId: string;
      readonly scrimId: string;
      readonly num: number;
    }
  | {
      readonly kind: "punish";
      readonly scrimId: string;
      readonly slotIds: readonly string[];
      readonly mode: BanMode;
    }
  | {
      readonly kind: "add_team";
      readonly scrimId: string;
      readonly num: number;
    }
  | {
      readonly kind: "change_team";
      readonly scrimId: string;
      readonly slotId: string;
    };

/** The pick tokens. */
const pickTokens = new TokenStore<PickContext>({ ttlMs: PICK_TTL_MS });

/** The modal tokens. */
const modalTokens = new TokenStore<ModalContext>({ ttlMs: MODAL_TTL_MS });

/** One choice in a pick menu. */
export interface PickOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly emoji?: string;
}

/** How a pick menu is shaped. */
export interface PickSettings {
  readonly placeholder?: string;
  readonly question?: string;
  /** How many values the member may choose. Defaults to 1. */
  readonly maxValues?: number;
  readonly ephemeral?: boolean;
}

/**
 * Shows a pick menu and waits for the choice.
 *
 * The menu is a real component in a message, so the choice arrives as
 * its own interaction — which is what makes the modal afterwards
 * possible.
 */
export async function showPick(
  interaction: RepliableInteraction,
  options: readonly PickOption[],
  context: PickContext,
  settings: PickSettings = {},
): Promise<void> {
  if (options.length === 0) {
    throw new TypeError("showPick needs at least one option");
  }

  const token = pickTokens.issue(context);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(slotsId("pick", token))
    .setPlaceholder(settings.placeholder ?? "Choose an option")
    .setMinValues(1)
    .setMaxValues(Math.min(settings.maxValues ?? 1, options.length));

  for (const option of options) {
    const builder = new SelectMenuOptionBuilder()
      .setLabel(option.label)
      .setValue(option.value);

    if (option.description) builder.setDescription(option.description);
    if (option.emoji) builder.setEmoji(option.emoji);

    menu.addOptions(builder);
  }

  await respond(
    interaction,
    settings.question
      ? { content: settings.question, components: [selectRow(menu)] }
      : { components: [selectRow(menu)] },
    settings.ephemeral ?? true,
  );
}

/**
 * Issues the token a modal carries.
 *
 * The modal's custom id is `slots:modal_*:<token>`; the token points at
 * the state the earlier steps of the flow collected.
 */
export function issueModalToken(context: ModalContext): string {
  return modalTokens.issue(context);
}

/**
 * Reads the state a modal carries.
 *
 * @returns the state, or `null` when the token is unknown or has
 *          expired.
 */
export function takeModalToken(token: string): ModalContext | null {
  return modalTokens.take(token) ?? null;
}

/** A handler for one kind of pick. */
export type PickHandler = (params: {
  readonly interaction: AnySelectMenuInteraction;
  readonly values: readonly string[];
  readonly context: PickContext;
}) => Promise<void>;

const pickHandlers = new Map<PickContext["kind"], PickHandler>();

/**
 * Registers the handler for a kind of pick.
 *
 * The registration order does not matter here: the kind is in the token,
 * not guessed from the id's shape.
 */
export function registerPickHandler(
  kind: PickContext["kind"],
  handler: PickHandler,
): void {
  pickHandlers.set(kind, handler);
}

/**
 * Handles the answer to a pick.
 *
 * @param token the token from the menu's custom id.
 */
export async function handlePick(
  interaction: AnySelectMenuInteraction,
  token: string,
): Promise<void> {
  const context = pickTokens.take(token);

  if (!context) {
    await respond(
      interaction,
      { content: "That menu is no longer active. Please run the command again." },
      true,
    );

    return;
  }

  const handler = pickHandlers.get(context.kind);

  if (!handler) {
    await respond(
      interaction,
      { content: "That menu is no longer active. Please run the command again." },
      true,
    );

    return;
  }

  await handler({
    interaction,
    values: interaction.values,
    context,
  });
}

/**
 * Takes the pick menu off its message.
 *
 * The menu is answered, so it must not stay live: a second press would
 * find no token and be refused, but the button would still be there
 * looking usable.
 */
export function clearPickMenu(
  interaction: AnySelectMenuInteraction,
): void {
  run(
    () => interaction.message.edit({ components: [] }),
    "slots.clearPickMenu",
  );
}

/** Stops the token stores. For tests and for shutdown. */
export function stopSlotTokens(): void {
  pickTokens.stop();
  modalTokens.stop();
}

/** The component type a pick menu uses. */
export const PICK_COMPONENT_TYPE = ComponentType.StringSelect;
