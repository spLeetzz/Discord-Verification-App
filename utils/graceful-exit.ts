import { MessageFlags } from "discord.js";
import type { Client, Interaction } from "discord.js";
import { flushLogs, logger } from "./logger.js";

export let draining = false;
export let activeCommands = 0;

type ShutdownHook = () => Promise<void> | void;

const shutdownHooks: ShutdownHook[] = [];

/**
 * Registers cleanup that has to run before the process exits.
 *
 * The bot holds a database pool and a job dispatcher, and neither is
 * released by `client.destroy()`. Without this the process hangs on exit
 * waiting for the pool's idle timeout.
 */
export function registerShutdownHook(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

export async function shutdown(client?: Client): Promise<void> {
  logger.info("Shutting down... Flushing logs.");

  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch (err) {
      logger.error("[Shutdown] Hook failed:", err);
    }
  }

  await flushLogs();
  client?.destroy();
  process.exit(0);
}

async function replyBotRestarting(
  interaction: Interaction | undefined,
): Promise<void> {
  if (!interaction) return;

  const content = "Bot is restarting. Please try again in a moment.";

  try {
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else if (interaction.isModalSubmit()) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else if (interaction.isButton()) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // The interaction is already gone — nothing to reply to.
  }
}

export async function handleCommand(
  interaction: Interaction | undefined,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (draining) {
    await replyBotRestarting(interaction);
    return;
  }

  activeCommands++;

  try {
    await fn();
  } finally {
    activeCommands--;
    if (draining && activeCommands === 0) await shutdown(interaction?.client);
  }
}

export function exitGracefully(client: Client): void {
  const signals = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.on(signal, async () => {
      logger.info(`Received ${signal}. Draining...`);
      draining = true;
      if (activeCommands === 0) await shutdown(client);
    });
  }

  process.on("uncaughtException", async (err) => {
    logger.error("Uncaught Exception:", err);
    await flushLogs();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason, promise) => {
    logger.error("Unhandled Rejection at:", promise, "reason:", reason);
    await flushLogs();
  });
}
