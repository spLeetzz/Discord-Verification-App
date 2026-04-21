import { REST, Routes } from "discord.js";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// deploy new commands on server

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commands = [];

const foldersPath = path.join(__dirname, "commands");
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
      commands.push(command.data.toJSON());
    } else {
      console.log(`[WARNING] ${filePath} missing data or execute.`);
    }
  }
}

const rest = new REST().setToken(process.env.BSSA_DISCORD_BOT_TOKEN);

try {
  console.log(`Deploying ${commands.length} commands globally...`);
  const data = await rest.put(
    Routes.applicationCommands(process.env.BSSA_CLIENT_ID),
    { body: commands },
  );
  console.log(`Done. ${data.length} commands deployed.`);
  process.exit(0);
} catch (error) {
  console.error(error);
}

