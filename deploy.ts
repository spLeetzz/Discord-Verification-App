// Must be first: importing this loads .env from the project root.
import { requireEnv } from "./utils/env.js";
import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { isCommand, listCommandFiles } from "./utils/command-files.js";

// deploy new commands on server

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

const foldersPath = path.join(__dirname, "commands");

if (fs.existsSync(foldersPath)) {
  for (const folder of fs.readdirSync(foldersPath)) {
    const categoryPath = path.join(foldersPath, folder);

    if (!fs.statSync(categoryPath).isDirectory()) continue;

    for (const filePath of listCommandFiles(categoryPath)) {
      const module = (await import(pathToFileURL(filePath).href)) as {
        default?: unknown;
      };

      if (isCommand(module.default)) {
        commands.push(module.default.data.toJSON());
      } else {
        console.log(`[WARNING] ${filePath} missing data or execute.`);
      }
    }
  }
}

const rest = new REST().setToken(requireEnv("BSSA_DISCORD_BOT_TOKEN"));
const clientId = requireEnv("BSSA_CLIENT_ID");
const guildId = requireEnv("GUILD_ID");

try {
  console.log(`Deploying ${commands.length} commands to guild ${guildId}...`);
  const data = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  })) as unknown[];

  console.log(`Done. ${data.length} commands deployed.`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
