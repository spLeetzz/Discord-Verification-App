// Loads .env from the project root so DATABASE_URL comes from the same
// place the bot reads it. drizzle-kit does not load .env on its own.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle config for the Quotient port.
 *
 * The schema is split by area under db/schema/*.ts and re-exported from
 * db/schema.ts, which is the single file drizzle-kit reads.
 *
 * `db:generate` writes SQL into db/migrations/; `db:migrate` applies it.
 * Never hand-edit a migration file — regenerate it instead.
 */
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://bssa:bssa@localhost:5433/bssa",
  },
  verbose: true,
  strict: true,
});
