import { defineConfig } from "drizzle-kit";

/**
 * Drizzle config for the Quotient port.
 *
 * The schema is split by area under db/schema/*.ts and re-exported from
 * db/schema.ts, which is the single file drizzle-kit reads.
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
