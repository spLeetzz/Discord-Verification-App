/**
 * The module's entry point.
 *
 * The manager calls {@link registerIdentity} from `handlers/listeners.ts`,
 * and {@link shutdownIdentity} from the graceful-exit path.
 *
 * The OCR provider is decided on and warmed up at boot: the decision says
 * whether the OCR runs at all, and the first Tesseract worker downloads the
 * language model — doing that lazily means the first screenshot of the day
 * waits for the download. The provider is shut down on the way out, so the
 * worker is terminated and the process can go.
 */

import { Events } from "discord.js";
import type { Client } from "discord.js";
import { logger } from "../../utils/logger.js";
import { loadChannelCache } from "./cache.js";
import { registerIdentityInteractions } from "./interactions.js";
import type { IdentityRouter } from "./interactions.js";
import { handleIdentityMessage } from "./listeners.js";
import { shutdownOcr, decideOcr, warmupOcr } from "./ocr.js";
import { stopSsWizardStore } from "./views/ssmod.js";

/**
 * Registers the area.
 *
 * @param client the Discord client.
 * @param router the component router. When it is given, the panel's
 *        buttons and menus work; without it the message listeners still
 *        do.
 */
export function registerIdentity(client: Client, router?: IdentityRouter): void {
  client.on(Events.MessageCreate, (message) => {
    void handleIdentityMessage(message);
  });

  if (router) {
    registerIdentityInteractions(router);
  }

  client.once(Events.ClientReady, () => {
    void warmIdentity();
  });
}

/**
 * Decides whether the OCR runs, loads the channel cache and warms the OCR
 * provider up.
 *
 * Called on `ClientReady`. The order matters:
 *
 *  1. the **OCR decision**, because it needs the database and because a
 *     screenshot must never be processed against a provider that was built
 *     with the wrong setting;
 *  2. the **channel cache**, because it is what tells the message listener
 *     whether a channel is one of ours — so it has to be loaded before the
 *     first message is looked at;
 *  3. the **warm-up**, so the language model is downloaded at startup
 *     rather than on the first screenshot of the day.
 */
export async function warmIdentity(): Promise<void> {
  try {
    await decideOcr();
  } catch (error) {
    // The decision does not throw — it falls back to a switched-off
    // provider — so this is only here for a bug in the decision itself.
    logger.error(
      "[Identity] Could not decide whether the OCR runs; screenshots will be refused.",
      error,
    );
  }

  try {
    await loadChannelCache();
  } catch (error) {
    logger.error(
      "[Identity] Could not load the channel cache; the message listeners will not fire until the bot restarts.",
      error,
    );
  }

  try {
    await warmupOcr();
  } catch (error) {
    logger.error("[Identity] Could not warm the OCR provider up.", error);
  }
}

/**
 * Releases everything this area holds.
 *
 * Call it when the bot shuts down.
 */
export async function shutdownIdentity(): Promise<void> {
  stopSsWizardStore();

  await shutdownOcr();
}
