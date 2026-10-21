import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import { isCommand, listCommandFiles } from "../utils/command-files.js";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadCommands(client: Client): Promise<void> {
  const foldersPath = path.join(__dirname, "..", "commands");

  if (!fs.existsSync(foldersPath)) {
    logger.warn("[Loader] Commands directory not found.");
    return;
  }

  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);

    // Only folders are command categories. A stray file directly under
    // commands/ would make readdirSync throw ENOTDIR and take the whole
    // loader down.
    if (!fs.statSync(commandsPath).isDirectory()) continue;

    const commandFiles = listCommandFiles(commandsPath);

    for (const filePath of commandFiles) {
      const module = (await import(pathToFileURL(filePath).href)) as {
        default?: unknown;
      };

      if (isCommand(module.default)) {
        client.commands.set(module.default.data.name, module.default);
      } else {
        logger.warn(`[Loader] ${filePath} is missing "data" or "execute".`);
      }
    }
  }
}
