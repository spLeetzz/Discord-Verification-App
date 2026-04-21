import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  Collection,
  MessageFlags,
} from "discord.js";
import { handleInteraction } from "./handlers/interactions.js";
import { loadCommands } from "./handlers/commands.js";
import { restoreVerificationEmbeds } from "./handlers/startup.js";
import { exitGracefully } from "./utils/graceful-exit.js";
import { logger } from "./utils/logger.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.commands = new Collection();

await loadCommands(client);

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.username}`);
  await restoreVerificationEmbeds(readyClient);
});

client.on(Events.InteractionCreate, handleInteraction);

client.login(process.env.BSSA_DISCORD_BOT_TOKEN);

exitGracefully(client);
