/**
 * The component handlers of this area.
 *
 * Every custom id is namespaced
 * `identity:ssmod:<surface>:<action>[:<target>]` (D7) and carries the
 * record it refers to (D18):
 *
 *  - `identity:ssmod:list:…` — the **list panel**. It carries no setup:
 *    its buttons start a wizard, show the FAQ and open the editor.
 *  - `identity:ssmod:edit:<action>:<configId>` — the **editor**. The
 *    setup exists, so its row id travels in the id and the panel
 *    survives a restart.
 *  - `identity:ssmod:wizard:<action>:<token>` — the **wizard**. The
 *    setup does not exist yet, so its state is a token.
 *
 * The surface is the segment right after the prefix, and it says what
 * the target is: a token for the wizard, a row id for the editor. The
 * handler therefore knows which of the two it is holding.
 *
 * The router dispatches on the prefix and **never guesses** an owner from
 * the shape of the rest of the id. The panel has **one** prefix —
 * `identity:ssmod` — so there is one registration per kind of component
 * and no pair of prefixes that can shadow each other. The old pair
 * (`identity:ssmod` and `identity:ssmod:wizard`) worked only because the
 * wizard was registered first, and the router warned about it.
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
import { replyError } from "../../core/context.js";
import { SSMOD_PREFIX, parseSsModId } from "./views/ids.js";
import {
  handleSsModButton,
  handleSsModModal,
  handleSsModSelect,
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
 * What a caller is told when the id is not one of this area's.
 *
 * The same words the router uses when nobody owns an id.
 */
const INACTIVE_MESSAGE =
  "This button is no longer active. Please run the command again.";

/**
 * Registers every component handler of this area.
 *
 * **One prefix, three registrations** — one per kind of component. The
 * order does not matter: there is no second prefix that could shadow
 * the first, and the router says so when it sees a pair like that.
 */
export function registerIdentityInteractions(router: IdentityRouter): void {
  router.registerButton(SSMOD_PREFIX, async (interaction, payload) => {
    const id = parseSsModId(payload);

    if (!id) {
      await replyError(interaction, INACTIVE_MESSAGE, { ephemeral: true });
      return;
    }

    await handleSsModButton(interaction, id);
  });

  router.registerSelect(SSMOD_PREFIX, async (interaction, payload) => {
    const id = parseSsModId(payload);

    if (!id) {
      await replyError(interaction, INACTIVE_MESSAGE, { ephemeral: true });
      return;
    }

    await handleSsModSelect(interaction, id);
  });

  router.registerModal(SSMOD_PREFIX, async (interaction, payload) => {
    const id = parseSsModId(payload);

    if (!id) {
      await replyError(interaction, INACTIVE_MESSAGE, { ephemeral: true });
      return;
    }

    await handleSsModModal(interaction, id);
  });
}
