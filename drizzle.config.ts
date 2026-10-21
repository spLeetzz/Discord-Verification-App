// Loads .env from the project root so DB_FILE comes from the same place
// the bot reads it. drizzle-kit does not load .env on its own.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { isAbsolute, resolve } from "node:path";

/**
 * Drizzle config for the Quotient port.
 *
 * The schema is split by area under db/schema/*.ts and re-exported from
 * db/schema.ts, which is the single file drizzle-kit reads.
 *
 * `db:generate` writes SQL into db/migrations/; `db:migrate` applies it.
 * Never hand-edit a migration file — regenerate it instead.
 *
 * **The dialect is SQLite.** The bot runs on a 1-CPU, 2 GB VPS, and the
 * schema is written in the dialect-neutral subset that `db/dialect.ts`
 * describes. `DB_MIGRATION_DRIVER` exists so that a future Postgres
 * migration folder can be generated without touching this file: it
 * selects which dialect the *schema objects* are built with while
 * generating.
 */
const driver = (process.env.DB_MIGRATION_DRIVER ?? "sqlite").trim();

// The schema is built once, at import time, from DB_DRIVER. Point it at
// the dialect this migration is being generated for.
process.env.DB_DRIVER = driver === "postgres" ? "postgres" : "sqlite";

/**
 * The database the tools talk to.
 *
 * The same `DB_FILE` the bot reads, in the `file:` form drizzle-kit
 * wants. A relative path is resolved against the working directory,
 * which is the project root when the script is run from it.
 */
function databaseUrl(): string {
  const configured = process.env.DB_FILE?.trim();

  if (!configured) return "file:./data/quotient.db";
  if (configured.startsWith("file:")) return configured;

  const path = isAbsolute(configured) ? configured : resolve(configured);

  return `file:${path}`;
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: driver === "postgres" ? "postgresql" : "sqlite",
  dbCredentials: {
    url: databaseUrl(),
  },
  verbose: true,
  strict: true,
});
