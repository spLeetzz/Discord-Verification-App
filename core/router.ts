/**
 * The component router.
 *
 * Every custom id is namespaced `<module>:<action>[:<payload>]` (D7), and
 * the router dispatches on the prefix. The router **never guesses**: an id
 * whose prefix nobody registered is logged and refused politely.
 *
 * Two rules that callers have to know:
 *
 *  - **Registration order matters.** The first registered prefix that
 *    matches an id wins, so a specific prefix has to be registered before
 *    a general one. `scrims:editor` before `scrims`.
 *  - **A prefix matches on a segment boundary.** `scrims` matches
 *    `scrims:claim:42`, and does *not* match `scrims_extra:claim:42`.
 *
 * There is one explicit exception: the frozen `verify_btn:<eventKey>` id
 * of the existing verification flow. `verify_btn` is not a module name —
 * it is a legacy id that predates the router — so it gets its own branch
 * rather than being treated as a module prefix.
 */

import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  RepliableInteraction,
} from "discord.js";
import { CUSTOM_ID_SEPARATOR } from "./custom-id.js";
import { replyError } from "./context.js";
import { logger } from "../utils/logger.js";

/**
 * The prefix of the frozen verification button.
 *
 * It is not a module name. The existing flow is frozen (D11), and this id
 * keeps working exactly as it did.
 */
export const LEGACY_VERIFY_PREFIX = "verify_btn";

/** A button handler. */
export type ButtonHandler = (
  interaction: ButtonInteraction,
  payload: string | null,
) => Promise<void> | void;

/** A select-menu handler. */
export type SelectHandler = (
  interaction: AnySelectMenuInteraction,
  payload: string | null,
) => Promise<void> | void;

/** A modal-submit handler. */
export type ModalHandler = (
  interaction: ModalSubmitInteraction,
  payload: string | null,
) => Promise<void> | void;

/**
 * The handler for the frozen verification button.
 *
 * The payload is the event key — the part after `verify_btn:`.
 */
export type LegacyVerifyHandler = (
  interaction: ButtonInteraction,
  eventKey: string | null,
) => Promise<void> | void;

interface Registration<H> {
  readonly prefix: string;
  /** Not readonly: a duplicate registration replaces the handler in place. */
  handler: H;
}

const buttonHandlers: Registration<ButtonHandler>[] = [];
const selectHandlers: Registration<SelectHandler>[] = [];
const modalHandlers: Registration<ModalHandler>[] = [];

let legacyVerifyHandler: LegacyVerifyHandler | null = null;

/**
 * Does a prefix own this custom id?
 *
 * The prefix has to end on a segment boundary, so `scrims` does not own
 * `scrims_extra:thing`.
 */
function matches(prefix: string, customId: string): boolean {
  return (
    customId === prefix ||
    customId.startsWith(`${prefix}${CUSTOM_ID_SEPARATOR}`)
  );
}

/**
 * The part of the custom id after the prefix.
 */
function payloadOf(prefix: string, customId: string): string | null {
  if (customId === prefix) return null;

  const payload = customId.slice(prefix.length + CUSTOM_ID_SEPARATOR.length);

  return payload === "" ? null : payload;
}

/**
 * Adds a registration, replacing a duplicate prefix in place.
 *
 * Replacing in place keeps the registration order stable when a module
 * registers itself twice — which happens when a module is reloaded.
 */
function add<H>(registry: Registration<H>[], prefix: string, handler: H): void {
  const existing = registry.find((entry) => entry.prefix === prefix);

  if (existing) {
    logger.warn(`[Router] Replacing the handler for "${prefix}".`);
    existing.handler = handler;
    return;
  }

  registry.push({ prefix, handler });
}

/**
 * Registers the handler for a button prefix.
 *
 * @param prefix  the prefix that owns the ids, e.g. `"scrims:claim"`.
 * @param handler called with the interaction and the rest of the id.
 */
export function registerButton(prefix: string, handler: ButtonHandler): void {
  add(buttonHandlers, prefix, handler);
}

/**
 * Registers the handler for a select-menu prefix.
 */
export function registerSelect(prefix: string, handler: SelectHandler): void {
  add(selectHandlers, prefix, handler);
}

/**
 * Registers the handler for a modal prefix.
 */
export function registerModal(prefix: string, handler: ModalHandler): void {
  add(modalHandlers, prefix, handler);
}

/**
 * Registers the handler for the frozen `verify_btn:<eventKey>` button.
 *
 * The manager wires this to the existing verification flow. Until it is
 * wired, the router leaves those buttons alone so the existing handler
 * keeps working.
 */
export function registerLegacyVerifyButton(handler: LegacyVerifyHandler): void {
  legacyVerifyHandler = handler;
}

/**
 * The prefixes that are currently registered.
 *
 * For diagnostics and tests.
 */
export function registeredPrefixes(): {
  buttons: string[];
  selects: string[];
  modals: string[];
} {
  return {
    buttons: buttonHandlers.map((entry) => entry.prefix),
    selects: selectHandlers.map((entry) => entry.prefix),
    modals: modalHandlers.map((entry) => entry.prefix),
  };
}

/**
 * Forgets every registration.
 *
 * For tests.
 */
export function clearRegistry(): void {
  buttonHandlers.length = 0;
  selectHandlers.length = 0;
  modalHandlers.length = 0;
  legacyVerifyHandler = null;
}

/**
 * Refuses an interaction nobody owns.
 */
async function refuseUnknown(
  interaction: RepliableInteraction,
  customId: string,
  kind: string,
): Promise<void> {
  logger.error(
    `[Router] No ${kind} handler registered for "${customId}". The id is not owned by any module.`,
  );

  await replyError(
    interaction,
    "This button is no longer active. Please run the command again.",
    { ephemeral: true },
  );
}

/**
 * Routes an interaction to the module that owns it.
 *
 * @returns `true` when the interaction was handled, `false` when it was
 *          not — which only happens for the legacy verification button
 *          when no legacy handler has been registered.
 */
export async function dispatch(interaction: RepliableInteraction): Promise<boolean> {
  if (interaction.isButton()) {
    const customId = interaction.customId;

    // The frozen verification button gets its own branch. It is not a
    // module name, and the flow behind it must keep working untouched.
    if (matches(LEGACY_VERIFY_PREFIX, customId)) {
      const handler = legacyVerifyHandler;

      if (!handler) {
        logger.warn(
          `[Router] No legacy handler registered for "${customId}"; leaving it to the existing flow.`,
        );
        return false;
      }

      const eventKey = payloadOf(LEGACY_VERIFY_PREFIX, customId);

      await handler(interaction, eventKey);

      return true;
    }

    const registration = buttonHandlers.find((entry) =>
      matches(entry.prefix, customId),
    );

    if (!registration) {
      await refuseUnknown(interaction, customId, "button");
      return true;
    }

    await registration.handler(
      interaction,
      payloadOf(registration.prefix, customId),
    );

    return true;
  }

  if (interaction.isAnySelectMenu()) {
    const customId = interaction.customId;

    const registration = selectHandlers.find((entry) =>
      matches(entry.prefix, customId),
    );

    if (!registration) {
      await refuseUnknown(interaction, customId, "select menu");
      return true;
    }

    await registration.handler(
      interaction,
      payloadOf(registration.prefix, customId),
    );

    return true;
  }

  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    const registration = modalHandlers.find((entry) =>
      matches(entry.prefix, customId),
    );

    if (!registration) {
      await refuseUnknown(interaction, customId, "modal");
      return true;
    }

    await registration.handler(
      interaction,
      payloadOf(registration.prefix, customId),
    );

    return true;
  }

  return false;
}
