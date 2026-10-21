/**
 * The component handlers of this area.
 *
 * Every custom id is namespaced `identity:<feature>:<action>[:<payload>]`
 * (D7) and carries the record it refers to (D18):
 *
 *  - `identity:ssmod:wizard:<action>:<token>` — the **wizard**. The setup
 *    does not exist yet, so its state is a token.
 *  - `identity:ssmod:<action>:<configId>` — the **editor**. The setup
 *    exists, so its row id travels in the id and the panel survives a
 *    restart.
 *
 * The router dispatches on the prefix and **never guesses** an owner from
 * the shape of the rest of the id. The wizard's prefix is registered
 * before the editor's, because the router takes the first prefix that
 * matches and `identity:ssmod` would match the wizard's ids too.
 *
 * The group management is **not** here. It was a second, unreachable copy
 * of the tournament area's own group manager, and its handlers created
 * channels and roles without checking the caller. It has been deleted; the
 * tournament area's version is the live one.
 *
 * The router itself is injected rather than imported: `core/router.ts` is
 * the manager's file, and this module must not depend on it. The shape
 * below is what `core/router.ts` provides.
 */

import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  SSMOD_PREFIX,
  SSMOD_WIZARD_PREFIX,
  handleSsModButton,
  handleSsModModal,
  handleSsModSelect,
  handleSsSetupButton,
  handleSsSetupModal,
  handleSsSetupSelect,
} from "./views/ssmod.js";

/** A button handler. */
export type IdentityButtonHandler = (
  interaction: ButtonInteraction,
  payload: string | null,
) => Promise<void> | void;

/** A select-menu handler. */
export type IdentitySelectHandler = (
  interaction: AnySelectMenuInteraction,
  payload: string | null,
) => Promise<void> | void;

/** A modal-submit handler. */
export type IdentityModalHandler = (
  interaction: ModalSubmitInteraction,
  payload: string | null,
) => Promise<void> | void;

/**
 * The router this area needs.
 *
 * Structurally the same as `core/router.ts`'s three `register*`
 * functions, so the router module itself can be handed over as-is.
 */
export interface IdentityRouter {
  registerButton(prefix: string, handler: IdentityButtonHandler): void;
  registerSelect(prefix: string, handler: IdentitySelectHandler): void;
  registerModal(prefix: string, handler: IdentityModalHandler): void;
}

/**
 * Registers every component handler of this area.
 *
 * The order matters: the wizard's prefix is more specific than the
 * editor's, and the router takes the first prefix that matches.
 */
export function registerIdentityInteractions(router: IdentityRouter): void {
  // The wizard first — `identity:ssmod` would match its ids too.
  router.registerButton(SSMOD_WIZARD_PREFIX, handleSsSetupButton);
  router.registerSelect(SSMOD_WIZARD_PREFIX, handleSsSetupSelect);
  router.registerModal(SSMOD_WIZARD_PREFIX, handleSsSetupModal);

  // The editor and the list panel.
  router.registerButton(SSMOD_PREFIX, handleSsModButton);
  router.registerSelect(SSMOD_PREFIX, handleSsModSelect);
  router.registerModal(SSMOD_PREFIX, handleSsModModal);
}
