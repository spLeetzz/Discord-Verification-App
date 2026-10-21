/**
 * The dialect seam.
 *
 * One schema, two dialects. This file is the only place in the codebase
 * that knows which SQL engine the bot is talking to.
 *
 * **Why it exists.** The bot ships on SQLite (a 1-CPU, 2 GB VPS cannot
 * afford a Postgres server) and may move to Postgres later. If the schema
 * were written against one engine's DDL, "moving to Postgres" would be a
 * rewrite of the schema *and* of every query that touches it. Instead the
 * schema is written in a dialect-neutral subset of SQL, and the differences
 * between the two engines are confined to the helpers below.
 *
 * **What the helpers hide.**
 *
 * | Concern | SQLite | Postgres |
 * |---|---|---|
 * | Primary key | `text` + `crypto.randomUUID()` in the app | `uuid` + `gen_random_uuid()` in the database |
 * | Timestamp | `integer`, epoch milliseconds | `timestamptz` |
 * | Boolean | `integer` 0/1, mapped by the driver | `boolean` |
 * | JSON | `text` holding JSON | `jsonb` |
 * | Arrays | *no such thing* — normalised into join tables | `text[]` |
 *
 * Every one of those is a *storage* difference with no effect on the shape
 * of the data the application sees: a timestamp is a `Date` on both, a
 * boolean is a `boolean` on both, a JSON column is a parsed object on both.
 *
 * **The one deliberate lie.** The *types* of these helpers are modelled on
 * the SQLite builders, because SQLite is the dialect that ships. The
 * Postgres branch casts its builders to the same types. That keeps a
 * single set of types for the schema, the modules and the tests, at the
 * cost of the seam asserting "SQLite" where the running engine may be
 * Postgres. The cast is confined to this file; nothing above `db/` can
 * tell the difference, which is the entire point.
 *
 * **What is left to do for Postgres.** See `db/README.md`. In short: write
 * the Postgres branch of each helper here, add the Postgres migration
 * folder, and point `DB_DRIVER` at it. The schema files do not change.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  BuildColumns,
  HasDefault,
  HasRuntimeDefault,
  IsPrimaryKey,
  NotNull,
} from "drizzle-orm/column-builder";
import {
  check as sqliteCheck,
  index as sqliteIndex,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  sqliteTable,
  text as sqliteText,
  unique as sqliteUnique,
  uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  AnySQLiteColumn,
  SQLiteBooleanBuilder,
  SQLiteCheckBuilder,
  SQLiteColumnBuilderBase,
  SQLiteIndexBuilder,
  SQLitePrimaryKeyBuilder,
  SQLiteTableExtraConfigValue,
  SQLiteTableWithColumns,
  SQLiteTextBuilder,
  SQLiteTextJsonBuilder,
  SQLiteTimestampBuilder,
  SQLiteUniqueConstraintBuilder,
} from "drizzle-orm/sqlite-core";
import {
  bigserial as pgBigserial,
  boolean as pgBoolean,
  check as pgCheck,
  index as pgIndex,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgTable,
  primaryKey as pgPrimaryKey,
  smallint as pgSmallint,
  text as pgText,
  timestamp as pgTimestamp,
  unique as pgUnique,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";

// Loads .env from the project root, so `DB_DRIVER` and `DB_FILE` are read
// from the same place the rest of the bot reads its configuration.
import "../utils/env.js";

/* ------------------------------------------------------------------ *
 * The active dialect
 * ------------------------------------------------------------------ */

/** The SQL engines this schema knows how to speak. */
export type Dialect = "sqlite" | "postgres";

/**
 * The dialect the bot is running against.
 *
 * `DB_DRIVER=sqlite` (the default) or `DB_DRIVER=postgres`. It is read
 * once, at module load, because the schema objects are built once.
 */
export const DIALECT: Dialect =
  process.env.DB_DRIVER?.trim().toLowerCase() === "postgres"
    ? "postgres"
    : "sqlite";

/** Whether the active dialect is Postgres. */
export const isPostgres: boolean = DIALECT === "postgres";

/* ------------------------------------------------------------------ *
 * Portable types
 *
 * These are the SQLite builder types, reused as the portable model. See
 * the note at the top of the file about the one deliberate lie.
 * ------------------------------------------------------------------ */

/** A column, as the schema and the constraints see it. */
export type PortableColumn = AnySQLiteColumn;

/** A column builder, as the schema sees it. */
export type PortableColumnBuilder = SQLiteColumnBuilderBase;

/** `text`. */
export type TextColumnBuilder = SQLiteTextBuilder<{
  name: string;
  dataType: "string";
  columnType: "SQLiteText";
  data: string;
  driverParam: string;
  enumValues: undefined;
  length: undefined;
}>;

/** `integer`. */
export type NumberColumnBuilder = SQLiteIntegerBuilder<{
  name: string;
  dataType: "number";
  columnType: "SQLiteInteger";
  data: number;
  driverParam: number;
  enumValues: undefined;
}>;

/** A boolean, stored as 0/1. */
export type BooleanColumnBuilder = SQLiteBooleanBuilder<{
  name: string;
  dataType: "boolean";
  columnType: "SQLiteBoolean";
  data: boolean;
  driverParam: number;
  enumValues: undefined;
}>;

/** A timestamp, stored as epoch milliseconds. */
export type TimestampColumnBuilder = SQLiteTimestampBuilder<{
  name: string;
  dataType: "date";
  columnType: "SQLiteTimestamp";
  data: Date;
  driverParam: number;
  enumValues: undefined;
}>;

/** JSON, stored as text and parsed on the way in and out. */
export type JsonColumnBuilder<T> = SQLiteTextJsonBuilder<{
  name: string;
  dataType: "json";
  columnType: "SQLiteTextJson";
  data: unknown;
  driverParam: string;
  enumValues: undefined;
  generated: undefined;
}> & { _: { $type: T } };

/** The primary key every table gets: a uuid generated in the app. */
export type IdColumnBuilder = HasRuntimeDefault<
  HasDefault<IsPrimaryKey<NotNull<TextColumnBuilder>>>
>;

/** The one serial primary key in the schema. */
export type SerialColumnBuilder = IsPrimaryKey<
  HasDefault<NotNull<NumberColumnBuilder>>
>;

/** A table, as the schema and the modules see it. */
export type PortableTable<
  TName extends string,
  TColumns extends Record<string, PortableColumnBuilder>,
> = SQLiteTableWithColumns<{
  name: TName;
  schema: undefined;
  columns: BuildColumns<TName, TColumns, "sqlite">;
  dialect: "sqlite";
}>;

/* ------------------------------------------------------------------ *
 * Column helpers
 * ------------------------------------------------------------------ */

/**
 * A `text` column.
 *
 * Discord snowflakes live here: they exceed `Number.MAX_SAFE_INTEGER`, so
 * a numeric column would silently round them.
 */
export function textCol(name: string): TextColumnBuilder {
  return (isPostgres ? pgText(name) : sqliteText(name)) as unknown as TextColumnBuilder;
}

/**
 * An `integer` column.
 *
 * Counts, positions and durations. Small enough for every column that
 * used to be a `smallint` in Postgres — SQLite has no small integer, and
 * the value range is the same either way.
 */
export function intCol(name: string): NumberColumnBuilder {
  return (isPostgres ? pgInteger(name) : sqliteInteger(name)) as unknown as NumberColumnBuilder;
}

/**
 * A `smallint` column on Postgres, an `integer` on SQLite.
 *
 * SQLite has no small integer type; its integers are 64-bit whatever the
 * declared type says, so the two are the same column.
 */
export function smallIntCol(name: string): NumberColumnBuilder {
  return (isPostgres ? pgSmallint(name) : sqliteInteger(name)) as unknown as NumberColumnBuilder;
}

/**
 * A boolean column.
 *
 * SQLite has no boolean type, so the column is an integer and the driver
 * maps 0/1 to `false`/`true` in both directions. The application still
 * sees a `boolean`.
 */
export function boolCol(name: string): BooleanColumnBuilder {
  return (isPostgres
    ? pgBoolean(name)
    : sqliteInteger(name, { mode: "boolean" })) as unknown as BooleanColumnBuilder;
}

/**
 * A JSON column.
 *
 * SQLite has no JSON type, so the column is text and the driver parses
 * it. `$type<T>` gives the shape to the type system on both dialects.
 *
 * @param defaultValue the value the column takes when a row is inserted
 *                     without one. It is written into the DDL as a
 *                     literal, so it has to be a constant.
 */
export function jsonCol<T>(
  name: string,
  defaultValue?: T,
): JsonColumnBuilder<T> {
  const builder = (isPostgres
    ? pgJsonb(name)
    : sqliteText(name, { mode: "json" })) as unknown as JsonColumnBuilder<T>;

  if (defaultValue === undefined) return builder;

  return builder.default(jsonLiteral(defaultValue)) as JsonColumnBuilder<T>;
}

/**
 * A timestamp column.
 *
 * Stored as epoch milliseconds on SQLite and as `timestamptz` on
 * Postgres. Both are instants; the IST offset is applied when something
 * is rendered for a human (D30).
 */
export function tsCol(name: string): TimestampColumnBuilder {
  return (isPostgres
    ? pgTimestamp(name, { withTimezone: true, mode: "date" })
    : sqliteInteger(name, { mode: "timestamp_ms" })) as unknown as TimestampColumnBuilder;
}

/**
 * The primary key every table gets.
 *
 * A uuid, generated in the application by `crypto.randomUUID()`. Postgres
 * could generate one in the database (`gen_random_uuid()`), but doing it
 * in the application means the id exists before the statement is sent —
 * which is what a join table, a `jobs.payload` and a Discord `custom_id`
 * all need.
 */
export function idCol(name = "id"): IdColumnBuilder {
  return textCol(name)
    .primaryKey()
    .$defaultFn(() => randomUUID()) as unknown as IdColumnBuilder;
}

/**
 * The one serial primary key in the schema.
 *
 * `command_usage` is the only high-write table and nothing references its
 * id, so it gets an auto-incrementing integer instead of a uuid.
 */
export function serialIdCol(name = "id"): SerialColumnBuilder {
  return (isPostgres
    ? pgBigserial(name, { mode: "number" })
    : sqliteInteger(name)) as unknown as SerialColumnBuilder;
}

/* ------------------------------------------------------------------ *
 * The table helper
 * ------------------------------------------------------------------ */

/**
 * Declares a table.
 *
 * The only difference between the two engines is the function that turns
 * a column map into a table; the columns, the constraints and the
 * inferred types are identical.
 */
export function defineTable<
  TName extends string,
  TColumns extends Record<string, PortableColumnBuilder>,
>(
  name: TName,
  columns: TColumns,
  extra?: (
    t: BuildColumns<TName, TColumns, "sqlite">,
  ) => SQLiteTableExtraConfigValue[],
): PortableTable<TName, TColumns> {
  const builders = columns as Record<string, unknown>;
  const extraConfig = extra as
    | ((t: unknown) => SQLiteTableExtraConfigValue[])
    | undefined;

  if (isPostgres) {
    return pgTable(
      name,
      builders as never,
      extraConfig as never,
    ) as unknown as PortableTable<TName, TColumns>;
  }

  return sqliteTable(
    name,
    builders as never,
    extraConfig as never,
  ) as unknown as PortableTable<TName, TColumns>;
}

/* ------------------------------------------------------------------ *
 * Constraints
 * ------------------------------------------------------------------ */

/** A non-unique index. */
export function index(name: string): SQLiteIndexBuilder {
  return (isPostgres ? pgIndex(name) : sqliteIndex(name)) as unknown as SQLiteIndexBuilder;
}

/** A unique constraint. */
export function unique(name: string): SQLiteUniqueConstraintBuilder {
  return (isPostgres
    ? pgUnique(name)
    : sqliteUnique(name)) as unknown as SQLiteUniqueConstraintBuilder;
}

/**
 * A unique index.
 *
 * `.where(...)` makes it a *partial* index. SQLite supports partial
 * indexes, so the one-live-alert rule works on both dialects.
 */
export function uniqueIndex(name: string): SQLiteIndexBuilder {
  return (isPostgres
    ? pgUniqueIndex(name)
    : sqliteUniqueIndex(name)) as unknown as SQLiteIndexBuilder;
}

/** A CHECK constraint. */
export function check(name: string, value: SQL): SQLiteCheckBuilder {
  return (isPostgres
    ? pgCheck(name, value)
    : sqliteCheck(name, value)) as unknown as SQLiteCheckBuilder;
}

/** A composite primary key. */
export function primaryKey(config: {
  columns: PortableColumn[];
  name?: string;
}): SQLitePrimaryKeyBuilder {
  return (isPostgres
    ? pgPrimaryKey(config as never)
    : sqlitePrimaryKey(config as never)) as unknown as SQLitePrimaryKeyBuilder;
}

/* ------------------------------------------------------------------ *
 * Literals
 * ------------------------------------------------------------------ */

/**
 * A JSON value as a SQL literal, for a column default.
 *
 * A default has to be a literal in the DDL — a bind parameter is not
 * allowed there — so the value is serialised and quoted. The value comes
 * from the schema's own constants, never from a user, and single quotes
 * are escaped anyway.
 */
function jsonLiteral(value: unknown): SQL {
  const serialised = JSON.stringify(value) ?? "null";

  return sql.raw(`'${serialised.replaceAll("'", "''")}'`);
}
