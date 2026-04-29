import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { logger } from "../utils/logger.js";

export async function loadCommands(client) {
  const foldersPath = path.join(__dirname, "..", "commands");

  if (!fs.existsSync(foldersPath)) {
    logger.warn("[Loader] Commands directory not found.");
    return;
  }

  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs
      .readdirSync(commandsPath)
      .filter((f) => f.endsWith(".js"));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const { default: command } = await import(filePath);

      if ("data" in command && "execute" in command) {
        client.commands.set(command.data.name, command);
      } else {
        logger.warn(`[Loader] ${file} is missing "data" or "execute".`);
      }
    }
  }
}
