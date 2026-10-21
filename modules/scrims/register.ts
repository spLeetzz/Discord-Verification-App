/**
 * The scrims module's entry points.
 *
 * Two things are exported:
 *
 *  - `registerScrims(client)` attaches the listeners — the manager
 *    calls it from `handlers/listeners.ts`.
 *  - `registerScrimsInteractions()` wires the custom ids into the core
 *    router. The manager calls it too.
 *
 * Neither touches a file another area owns.
 */

import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { registerButton, registerModal, registerSelect } from "../../core/router.js";
import { run } from "../../core/fire-and-forget.js";
import { logger } from "../../utils/logger.js";
import { handleRegistrationMessage } from "./listeners.js";
import { handleScrimJob, rebuildChannelCache } from "./jobs.js";
import { handleScrimsButton } from "./views/button-handlers.js";
import { handleScrimsModal } from "./views/modal-handlers.js";
import { handleScrimsSelect } from "./views/select-handlers.js";
import { parseScrimsId } from "./views/ids.js";
import { scrimChannelCache } from "./channel-cache.js";

/**
 * Registers the scrims listeners.
 *
 * The manager's registry looks for `registerScrimsListeners(client)`.
 * The `MessageCreate` listener is the registration intake; nothing else
 * in this area listens to messages.
 */
export function registerScrimsListeners(client: Client): void {
  client.on("messageCreate", (message) => {
    if (message.author.bot) return;

    run(
      async () => {
        await handleRegistrationMessage(message);
      },
      "scrims.messageCreate",
    );
  });

  // The cache is rebuilt at startup so the bot does not ask the database
  // about every message it sees.
  run(async () => {
    await rebuildChannelCache();
  }, "scrims.rebuildChannelCache");

  logger.info(
    `[Scrims] Registered. The cache holds ${scrimChannelCache.size} registration channels.`,
  );
}

/**
 * Registers the scrims listeners.
 *
 * The name the brief used. The manager's registry uses the longer one.
 */
export const registerScrims = registerScrimsListeners;

/**
 * Registers the scrims custom ids.
 *
 * Every scrims id starts with `scrims:`, so one prefix owns them all and
 * the router never has to guess.
 */
export function registerScrimsInteractions(): void {
  registerButton("scrims", async (interaction, payload) => {
    const id = parseScrimsId(
      payload === null ? "scrims:" : `scrims:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That button is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleScrimsButton(interaction, id.action, id.parts);
  });

  registerSelect("scrims", async (interaction, payload) => {
    const id = parseScrimsId(
      payload === null ? "scrims:" : `scrims:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That menu is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleScrimsSelect(interaction, id.action);
  });

  registerModal("scrims", async (interaction, payload) => {
    const id = parseScrimsId(
      payload === null ? "scrims:" : `scrims:${payload}`,
    );

    if (!id) {
      await interaction.reply({
        content: "That form is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handleScrimsModal(interaction, id.action, id.parts);
  });
}

/**
 * The job handler the scheduler calls.
 *
 * The manager's registry looks for `handleScrimsJob(client, event,
 * payload)`; the scheduler is manager-owned and this is the half that
 * belongs to the scrims area.
 */
export async function handleScrimsJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void> {
  await handleScrimJob(event, payload, client);
}

/** The job handler, in the argument order the brief used. */
export async function dispatchScrimJob(
  event: string,
  payload: unknown,
  client: Client,
): Promise<void> {
  await handleScrimJob(event, payload, client);
}

export { handleRegistrationMessage, handleScrimJob, rebuildChannelCache };
export { scrimChannelCache };
