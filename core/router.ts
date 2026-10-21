/**
 * The component router.
 *
 * Every custom id is namespaced `<module>:<action>[:<payload>]` (D7), and
 * the router dispatches on the prefix. The router **never guesses**: an id
 * whose prefix nobody registered is logged and refused politely.
 *
 * Four rules that callers have to know:
 *
 *  - **Registration order matters.** The first registered prefix that
 *    matches an id wins, so a specific prefix has to be registered before
 *    a general one. `scrims:editor` before `scrims`.
 *  - **A prefix matches on a segment boundary.** `scrims` matches
 *    `scrims:claim:42`, and does *not* match `scrims_extra:claim:42`.
 *  - **A prefix must not be a segment-prefix of another prefix.** If an
 *    area registers `identity:ssmod` and `identity:ssmod:setup`, one of
 *    the two can never be reached. The router says so — loudly, and by
 *    name — when the second one is registered.
 *  - **The id's shape and the handler's comparison must agree.** An id of
 *    `tourneys:select:pick` carries the action `select` and the
 *    sub-action `pick`; a handler that compares the action against
 *    `pick` refuses every pick. The comparison lives in the handler, so
 *    the router cannot check it — the area owns that one.
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
import { COLLECTOR_CUSTOM_ID_PREFIX, CUSTOM_ID_SEPARATOR } from "./custom-id.js";
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

/**
 * The kind of component a registration owns.
 *
 * Buttons, select menus and modals are separate namespaces: the router
 * dispatches each kind on its own list, so a button prefix never shadows
 * a modal prefix.
 */
type RouterCategory = "button" | "select menu" | "modal";

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
 * The area a prefix belongs to.
 *
 * The first segment of a custom id names its owner (`custom-id.ts`), so
 * the first segment of a prefix names the area that registered it. The
 * warning names it, because "somebody registered a prefix" is not
 * actionable and "the identity area registered two of them" is.
 */
function areaOf(prefix: string): string {
  const cut = prefix.indexOf(CUSTOM_ID_SEPARATOR);

  return cut === -1 ? prefix : prefix.slice(0, cut);
}

/**
 * Does `shadow` own every id that `covered` owns?
 *
 * The router matches on a segment boundary, so `shadow` owns every id
 * `covered` owns exactly when `shadow` is a **proper segment-prefix** of
 * `covered`:
 *
 *  - `identity:ssmod` owns every id `identity:ssmod:setup:42` owns;
 *  - `identity:ssmod:wizard` owns none of them.
 *
 * Two equal prefixes are a duplicate rather than a shadow, so this is
 * false for them.
 */
function shadows(shadow: string, covered: string): boolean {
  if (shadow === covered) return false;

  return matches(shadow, covered);
}

/**
 * Adds a registration, replacing a duplicate prefix in place.
 *
 * Replacing in place keeps the registration order stable when a module
 * registers itself twice — which happens when a module is reloaded.
 *
 * Two things go wrong here, and both of them are invisible to the type
 * system and to the tests, so both are logged:
 *
 *  - a **duplicate** prefix — two areas claiming the same id space, or
 *    an area registering twice. The last registration wins, and the other
 *    one is a feature that silently does nothing.
 *  - a **shadowing pair** — two prefixes where one is a segment-prefix
 *    of the other. The router takes the first matching prefix, so one of
 *    the two can never be reached. Which one depends on the order, and
 *    the warning says which.
 */
function add<H>(
  registry: Registration<H>[],
  prefix: string,
  handler: H,
  category: RouterCategory,
): void {
  const area = areaOf(prefix);
  const existing = registry.find((entry) => entry.prefix === prefix);

  if (existing) {
    logger.warn(
      `[Router] Duplicate ${category} prefix "${prefix}" in area "${area}". ` +
        `The earlier handler is replaced and the last registration wins. ` +
        `Two areas claiming the same id space, or an area registering twice, ` +
        `is a bug: the loser of it is a feature that silently does nothing.`,
    );

    existing.handler = handler;

    return;
  }

  for (const entry of registry) {
    if (shadows(entry.prefix, prefix)) {
      // The earlier prefix is the broader one, so it owns the new prefix
      // outright and the new prefix can never be reached.
      logger.warn(
        `[Router] Prefix shadowing in area "${area}": the ${category} prefix ` +
          `"${entry.prefix}" (registered first) shadows "${prefix}" (registered now). ` +
          `Every id that matches "${prefix}" also matches "${entry.prefix}", and the ` +
          `router takes the first matching prefix, so "${prefix}" is unreachable — ` +
          `the handler behind it never runs. Register the more specific prefix first, ` +
          `or give the two prefixes their own namespaces.`,
      );
    } else if (shadows(prefix, entry.prefix)) {
      // The new prefix is the broader one, so it would own the earlier
      // prefix — but the earlier prefix is first in the list and keeps
      // its own ids. The pair works only because of the order.
      logger.warn(
        `[Router] Prefix shadowing in area "${area}": the ${category} prefix ` +
          `"${entry.prefix}" (registered first) wins over "${prefix}" (registered now) — ` +
          `the router takes the first matching prefix. "${prefix}" owns every id ` +
          `"${entry.prefix}" owns, so the pair works only because of the registration ` +
          `order: registering "${prefix}" first would make "${entry.prefix}" unreachable. ` +
          `Register one prefix and dispatch on the second segment, or namespace the two ` +
          `so that neither can shadow the other.`,
      );
    }
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
  add(buttonHandlers, prefix, handler, "button");
}

/**
 * Registers the handler for a select-menu prefix.
 */
export function registerSelect(prefix: string, handler: SelectHandler): void {
  add(selectHandlers, prefix, handler, "select menu");
}

/**
 * Registers the handler for a modal prefix.
 */
export function registerModal(prefix: string, handler: ModalHandler): void {
  add(modalHandlers, prefix, handler, "modal");
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
 * Is this custom id owned by a pending collector?
 *
 * A collector — a select menu waiting for a channel, a prompt waiting for
 * a confirmation — owns the interaction that answers it. No module
 * registered that id, so the router would otherwise refuse it: it would
 * reply "This button is no longer active", that reply would acknowledge
 * the interaction, and the collector's own `update` would then fail. The
 * user would be told a button had expired when all they had done was
 * pick a channel.
 *
 * The answer is silence. The collector is waiting for this interaction,
 * and it is the only thing that knows what the answer means.
 */
function ownedByCollector(customId: string): boolean {
  return matches(COLLECTOR_CUSTOM_ID_PREFIX, customId);
}

/**
 * Routes an interaction to the module that owns it.
 *
 * @returns `true` when the interaction was handled, `false` when it was
 *          not — which only happens for the legacy verification button
 *          when no legacy handler has been registered.
 */
export async function dispatch(interaction: RepliableInteraction): Promise<boolean> {
  // A collector's component is not the router's to route. It is checked
  // first, before any handler is looked for, because there will never be
  // one: the collector is the owner.
  if (
    interaction.isButton() ||
    interaction.isAnySelectMenu() ||
    interaction.isModalSubmit()
  ) {
    if (ownedByCollector(interaction.customId)) {
      return true;
    }
  }

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
