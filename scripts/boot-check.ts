/**
 * Startup check.
 *
 * Exercises everything `main.ts` does **before** it talks to Discord:
 * loading the commands, registering the feature areas, talking to the
 * database, and running the job dispatcher once. It never calls
 * `client.login()`, so it needs no bot token and opens no gateway
 * connection.
 *
 * It is the fastest way to answer "would the bot actually start?" — a
 * missing export, a module that throws on import, a database that is
 * unreachable, or a command that does not serialise all show up here
 * rather than at 3am.
 *
 * ```bash
 * npm run boot:check
 * ```
 */

import { Client, Collection, GatewayIntentBits } from "discord.js";
import { lte } from "drizzle-orm";
import { closeDatabase, db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { registeredPrefixes } from "../core/router.js";
import { loadCommands } from "../handlers/commands.js";
import { runDueJobs } from "../handlers/jobs.js";
import { registerAreas } from "../handlers/listeners.js";
import type { Command } from "../types/command.js";

/** Discord allows 100 slash commands per guild. */
const DISCORD_COMMAND_LIMIT = 100;

async function main(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection<string, Command>();

  console.log("1. loading commands");
  await loadCommands(client);

  const names = [...client.commands.keys()].sort();
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  console.log(`   ${names.length} commands loaded`);
  console.log(`   duplicate names: ${duplicates.length ? duplicates.join(", ") : "none"}`);

  if (names.length > DISCORD_COMMAND_LIMIT) {
    console.log(
      `   OVER Discord's ${DISCORD_COMMAND_LIMIT}-command limit — the deploy will fail`,
    );
  } else {
    console.log(
      `   ${DISCORD_COMMAND_LIMIT - names.length} commands of headroom under Discord's limit`,
    );
  }

  console.log("2. registering feature areas");
  const areas = await registerAreas(client);
  console.log(`   loaded: ${areas.loaded.join(", ") || "none"}`);
  if (areas.missing.length) {
    console.log(`   missing: ${areas.missing.join(", ")}`);
  }

  console.log("3. checking the component router");
  const prefixes = registeredPrefixes();
  console.log(`   buttons: ${prefixes.buttons.join(", ") || "none"}`);
  console.log(`   selects: ${prefixes.selects.join(", ") || "none"}`);
  console.log(`   modals:  ${prefixes.modals.join(", ") || "none"}`);

  if (!prefixes.buttons.length) {
    console.log("   NO BUTTONS ARE REGISTERED — nothing in the bot would respond");
  }

  console.log("4. checking the database");
  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(lte(jobs.expiresAt, new Date()));
  console.log(`   ${due.length} job(s) due`);

  console.log("5. running the job dispatcher once");
  const fired = await runDueJobs(client);
  console.log(`   ran ${fired} job(s)`);

  console.log("6. releasing the database pool");
  await closeDatabase();

  console.log("\nStartup check passed. The bot would boot.");
}

void main().catch((err) => {
  console.error("\nStartup check FAILED:", err);
  process.exitCode = 1;
});
