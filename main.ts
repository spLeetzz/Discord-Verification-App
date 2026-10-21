// Must be first: importing this loads .env from the project root, before
// anything else reads a variable from the environment.
import { requireEnv } from "./utils/env.js";
import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { enabledEvents } from "./config/events.js";
import { closeDatabase } from "./db/client.js";
import { handleInteraction } from "./handlers/interactions.js";
import { handleMessage } from "./handlers/messages.js";
import { loadCommands } from "./handlers/commands.js";
import { stopJobDispatcher } from "./handlers/jobs.js";
import { restoreVerificationEmbeds, startAreas } from "./handlers/startup.js";
import { startCache } from "./repo/cache.js";
import { spreadsheetIdFor } from "./repo/config.js";
import type { Command } from "./types/command.js";
import { exitGracefully, registerShutdownHook } from "./utils/graceful-exit.js";
import { logger } from "./utils/logger.js";

// Fail fast, before any network calls, if the environment is incomplete.
requireEnv("BSSA_DISCORD_BOT_TOKEN");

if (!process.env.GOOGLE_KEY_PATH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error(
    "Missing Google credentials. Set GOOGLE_KEY_PATH or GOOGLE_APPLICATION_CREDENTIALS.",
  );
}

// Every enabled event needs a spreadsheet to read from and write to.
for (const eventKey of enabledEvents()) {
  spreadsheetIdFor(eventKey);
}

/**
 * The bot is a member of several guilds, but only one of them runs a
 * tournament. Interactions from anywhere else are ignored.
 */
const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID ?? "";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    // The tournament registration path reacts to a ✅ on a message. Without
    // this intent the reaction event never fires and the feature is dead
    // without any error (D33).
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.commands = new Collection<string, Command>();

await loadCommands(client);
await startCache();

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.username}`);
  await restoreVerificationEmbeds(readyClient);
  await startAreas(readyClient);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (ALLOWED_GUILD_ID && interaction.guildId !== ALLOWED_GUILD_ID) {
    logger.debug(
      `[InteractionCreate] Ignoring interaction from guild ${interaction.guildId}.`,
    );
    return;
  }

  void handleInteraction(interaction);
});

// A captain can mention his players in a ticket thread; the bot adds them so
// they can actually see it and post their own details.
client.on(Events.MessageCreate, (message) => {
  if (ALLOWED_GUILD_ID && message.guildId !== ALLOWED_GUILD_ID) return;

  void handleMessage(message);
});

client.login(requireEnv("BSSA_DISCORD_BOT_TOKEN"));

// The job dispatcher holds a database pool and a timer; the database holds
// connections. Both have to be released or the process hangs on exit.
registerShutdownHook(async () => {
  stopJobDispatcher();
  await closeDatabase();
});

exitGracefully(client);
