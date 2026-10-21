/**
 * The tournaments module's entry points.
 *
 * Two things are exported:
 *
 *  - `registerTourneys(client)` attaches the listeners — the manager
 *    calls it from `handlers/listeners.ts`.
 *  - `registerTourneysInteractions()` wires the custom ids into the core
 *    router. The manager calls it too.
 *
 * Neither touches a file another area owns.
 */

import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { registerButton, registerModal, registerSelect } from "../../core/router.js";
import { run } from "../../core/fire-and-forget.js";
import { logger } from "../../utils/logger.js";
import {
  handleMediaPartnerMessage,
  handleMessageDelete,
  handleReactionAdd,
  handleRegistrationMessage,
} from "./listeners.js";
import { handleTourneysJobEvent, rebuildChannelCache } from "./jobs.js";
import { handleTourneysButton } from "./views/button-handlers.js";
import { handleTourneysModal } from "./views/modal-handlers.js";
import { handleTourneysSelect } from "./views/select-handlers.js";
import { parseTourneysId } from "./views/ids.js";

/**
 * Registers the tournaments listeners.
 *
 * The manager calls this from `handlers/listeners.ts` — it looks the
 * function up as `registerTourneysListeners`.
 *
 * The `messageReactionAdd` listener needs
 * `GatewayIntentBits.GuildMessageReactions` (D33). Without it, the
 * reaction-based registration path is silently dead — no error, just no
 * registrations.
 */
export function registerTourneysListeners(client: Client): void {
  client.on("messageCreate", (message) => {
    if (message.author.bot) return;

    run(
      async () => {
        await handleRegistrationMessage(message);
        await handleMediaPartnerMessage(message);
      },
      "tourneys.messageCreate",
    );
  });

  client.on("messageReactionAdd", (reaction, user) => {
    run(
      async () => {
        await handleReactionAdd(reaction, user);
      },
      "tourneys.messageReactionAdd",
    );
  });

  client.on("messageDelete", (message) => {
    run(
      async () => {
        await handleMessageDelete(message);
      },
      "tourneys.messageDelete",
    );
  });

  // The caches are rebuilt at startup so the bot does not ask the
  // database about every message it sees.
  run(
    async () => {
      await rebuildChannelCache();
    },
    "tourneys.rebuildChannelCache",
  );

  logger.info("[Tourneys] Registered.");
}

/**
 * Registers the tournaments custom ids.
 *
 * Every tourneys id starts with `tourneys:`, so one prefix owns them
 * all and the router never has to guess.
 */
export function registerTourneysInteractions(): void {
  registerButton("tourneys", async (interaction, payload) => {
    const id = parseTourneysId(
      payload === null ? "tourneys:" : `tourneys:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That button is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleTourneysButton(interaction, id.action, id.parts);
  });

  registerSelect("tourneys", async (interaction, payload) => {
    const id = parseTourneysId(
      payload === null ? "tourneys:" : `tourneys:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That menu is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleTourneysSelect(interaction, id.action, id.parts);
  });

  registerModal("tourneys", async (interaction, payload) => {
    const id = parseTourneysId(
      payload === null ? "tourneys:" : `tourneys:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That form is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // A modal's custom id is `tourneys:modal:<kind>:<parts…>`, so the
    // *kind* is the first part and the rest is the payload.
    const [kind, ...parts] = id.parts;

    if (!kind) {
      await interaction.reply({
        content: "That form is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleTourneysModal(interaction, kind, parts);
  });
}

/**
 * The job handler the scheduler calls.
 *
 * The scheduler is manager-owned; this is the half that belongs to the
 * tournaments area. The manager wires it with
 * `registerJobHandler(event, handler)`, so the handler has to answer for
 * the events it is registered for.
 */
export async function handleTourneysJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void> {
  await handleTourneysJobEvent(client, event, payload);
}

/**
 * The alias the area's own code uses.
 *
 * The manager's registry looks the function up as
 * `registerTourneysListeners`; this name is kept because it reads
 * better at the call site in `handlers/listeners.ts`.
 */
export const registerTourneys = registerTourneysListeners;

export {
  handleMediaPartnerMessage,
  handleMessageDelete,
  handleReactionAdd,
  handleRegistrationMessage,
  handleTourneysJobEvent,
  rebuildChannelCache,
};
