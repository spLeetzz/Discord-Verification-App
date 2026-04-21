import { flushLogs, logger } from "./logger.js";
import { MessageFlags } from "discord.js";

export let draining = false;
export let activeCommands = 0;

export async function shutdown(client) {
  logger.info("Shutting down... Flushing logs.");
  await flushLogs();
  if (client) client.destroy();
  process.exit(0);
}

export async function handleCommand(interaction, fn) {
  if (draining) {
    await interaction
      ?.reply({
        content: "Bot is restarting. Please try again in a moment.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  activeCommands++;
  try {
    await fn();
  } finally {
    activeCommands--;
    if (draining && activeCommands === 0) await shutdown(interaction.client);
  }
}

export function exitGracefully(client) {
  const signals = ["SIGINT", "SIGTERM"];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}. Draining...`);
      draining = true;
      if (activeCommands === 0) await shutdown(client);
    });
  });

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
