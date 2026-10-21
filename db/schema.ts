/**
 * The database schema — the one file every other module imports.
 *
 * The definitions are split by area under `db/schema/` and re-exported here
 * so that `drizzle-kit` (which reads a single entry point) and the modules
 * (which want one import) both see the same tables.
 *
 * Nothing outside `db/` writes DDL. Modules import the table objects from
 * here and use drizzle's query builder; they never spell out SQL that
 * changes the shape of a table.
 *
 * The columns themselves come from `db/dialect.ts`, which is the only file
 * that knows whether the bot is talking to SQLite or Postgres. The schema
 * files never import a dialect's own module.
 *
 * `db/` is the SQL layer. `repo/` is the Google Sheets layer. Two
 * directories, two meanings, no confusion.
 */

export * from "./schema/common.js";
export * from "./schema/esports.js";
export * from "./schema/premium.js";
export * from "./schema/identity.js";
export * from "./schema/system.js";
