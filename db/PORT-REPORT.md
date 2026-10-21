# `db/` — the SQLite port: report

The schema is ported. `db/` compiles with zero errors, the schema test
passes (19 tests), and the boot path creates all 46 tables in an empty
database.

**The engine is SQLite** (`@libsql/client` + `drizzle-orm/libsql`). The
schema is written in a dialect-neutral subset of SQL and `db/dialect.ts` is
the only file in the codebase that knows which engine is in use.

---

## 1. `db/dialect.ts` — the final API

### Dialect selection

| Export | Type | What it is |
|---|---|---|
| `DIALECT` | `"sqlite" \| "postgres"` | The active dialect, read once from `DB_DRIVER` at module load. `sqlite` is the default. |
| `isPostgres` | `boolean` | `DIALECT === "postgres"`. |
| `Dialect` | `"sqlite" \| "postgres"` | The type of the two. |

### Column helpers

| Helper | Returns | SQLite | Postgres | The app sees |
|---|---|---|---|---|
| `textCol(name)` | `TextColumnBuilder` | `text` | `text` | `string` |
| `foreignIdCol(name)` | `TextColumnBuilder` | `text` | `text` | `string` — a FK to an `idCol` |
| `intCol(name)` | `NumberColumnBuilder` | `integer` | `integer` | `number` |
| `smallIntCol(name)` | `NumberColumnBuilder` | `integer` | `smallint` | `number` |
| `boolCol(name)` | `BooleanColumnBuilder` | `integer` 0/1 | `boolean` | `boolean` |
| `jsonCol<T>(name, defaultValue?)` | `JsonColumnBuilder<T>` | `text` holding JSON | `jsonb` | `T` |
| `tsCol(name)` | `TimestampColumnBuilder` | `integer`, epoch ms | `timestamptz` | `Date` |
| `idCol(name = "id")` | `IdColumnBuilder` | `text` + `crypto.randomUUID()` | `uuid` + `gen_random_uuid()` | `string` |
| `serialIdCol(name = "id")` | `SerialColumnBuilder` | `integer primary key autoincrement` | `bigserial` | `number` |
| `createdAtCol(name = "created_at")` | `TimestampDefaultColumnBuilder` | filled in the app | filled in the app | `Date` |
| `updatedAtCol(name = "updated_at")` | `TimestampDefaultColumnBuilder` | as above, plus `$onUpdate` | as above | `Date` |

### Table and constraints

| Helper | Returns |
|---|---|
| `defineTable(name, columns, extra?)` | `PortableTable<TName, TColumns>` — the `sqliteTable` / `pgTable` split lives here |
| `index(name)` | `IndexBuilderOn` — `.on(...)` |
| `unique(name)` | `UniqueOnConstraintBuilder` — `.on(...)` |
| `uniqueIndex(name)` | `IndexBuilderOn` — `.on(...).where(sql)` (a **partial** index) |
| `check(name, value)` | `CheckBuilder` |
| `primaryKey({ columns, name? })` | `PrimaryKeyBuilder` — the composite key of `guild_entitlements` |

### Portable types

`PortableColumn`, `PortableColumnBuilder`, `PortableTable<TName, TColumns>`,
plus the builder aliases above, are re-exported so that no schema file ever
imports `drizzle-orm/sqlite-core` or `drizzle-orm/pg-core`.

**The one deliberate lie.** The types are modelled on the SQLite builders,
because SQLite is the dialect that ships; the Postgres branch casts its
builders to the same types. The cast is confined to `db/dialect.ts`. This
is what keeps one set of types for the schema, the modules and the tests —
and it is why `modules/premium/repo.ts` can import a `DbExecutor` instead of
naming a driver.

---

## 2. The driver: `@libsql/client`

**Chosen:** `@libsql/client` ^0.18.0 with `drizzle-orm/libsql`.

Why:

- **It is asynchronous.** The whole codebase does `await db.select(...)`.
  With a promise-based driver that is unchanged; with `better-sqlite3` the
  transaction helper and `withLockedTransaction` would have to be
  rewritten, because drizzle's better-sqlite3 driver has no
  `db.transaction(async fn)`.
- **It is a local file.** No server, no connection string, no pool — which
  is what a 1-CPU, 2 GB VPS can afford. `DB_FILE` points at the file.
- **Foreign keys are enforced by default.** `PRAGMA foreign_keys` is `1`
  on a libsql connection (verified), so `ON DELETE CASCADE` actually
  cascades. A bare `better-sqlite3` connection has foreign keys **off** by
  default, which would have made the cascade requirement silently false.
- **The native binding is fast** and there is a WASM fallback.

The trade-off: SQLite has one writer. `modules/slots/repo.ts` already
carries a retry loop for `SQLITE_BUSY`; that is the belt to the braces of
a busy timeout, and the busy timeout is a `db/client.ts` change (not
mine — it is listed below).

---

## 3. The array columns, before and after

**There are twelve array columns, not eight.** The brief listed eight; the
Postgres schema had twelve. Every one of them is now a join table.

| Before | After | Notes |
|---|---|---|
| `slots.members text[]` | `slot_members(slot_id, user_id)` | The whole team, not just the captain (B3). |
| `reserved_slots.members text[]` | `reserved_slot_members(reserved_slot_id, user_id)` | **Not in the brief's list.** |
| `banned_teams.members text[]` | `banned_team_members(banned_team_id, user_id)` | **Not in the brief's list.** The ban survives a rename. |
| `tourney_slots.members text[]` | `tourney_slot_members(tourney_slot_id, user_id)` | |
| `media_partner_slots.members text[]` | `media_partner_slot_members(media_partner_slot_id, user_id)` | **Not in the brief's list.** |
| `scrims.autoclean text[]` | `scrim_autoclean(scrim_id, kind)` | `kind` is `channel` or `role`. |
| `scrims.open_days text[]` | `scrim_open_days(scrim_id, day)` | `day` is a weekday name. |
| `lockdowns.channel_ids text[]` | `lockdown_channels(lockdown_id, channel_id)` | |
| `lockdowns.maintenance_channel_ids text[]` | `lockdown_maintenance_channels(lockdown_id, channel_id)` | **Not in the brief's list.** |
| `autorole_configs.humans text[]` and `.bots text[]` | `autorole_roles(guild_id, kind, role_id)` | `kind` is `human` or `bot`. One table replaces two columns. |
| `ss_configs.keywords text[]` | `ss_config_keywords(ss_config_id, keyword)` | |
| `tourneys.banned_users` | `tourney_banned_users` | Already a join table. Kept. |
| `slot_managers.scrim_ids` | `slot_manager_scrims` | Already a join table. Kept. |

Every join table has an `id` uuid primary key, `created_at`, `updated_at`, a
unique constraint on its key columns, and an `ON DELETE CASCADE` foreign key
to its owner. `autorole_roles.guild_id` references `autorole_configs.guild_id`
(which is unique), so the cascade works there too.

**The names match the module port that is already in flight.** The
concurrent module work imports `slotMembers`, `reservedSlotMembers`,
`bannedTeamMembers`, `scrimOpenDays`, `scrimAutoclean`,
`tourneySlotMembers`, `mediaPartnerSlotMembers`, `autoroleRoles`,
`lockdownChannels` and `lockdownMaintenanceChannels`, and uses exactly the
columns above (`slot_id`/`user_id`, `scrim_id`/`day`, `guild_id`/`kind`/
`role_id`, …). No rename is needed.

**The overlap checks are now joins**, which is faster than the array
operator `&&` was. The claim itself (§S7) survives unchanged apart from
`members = $5` disappearing from the `SET` list — the members are rows in
`slot_members`, written in the same transaction.

---

## 4. The migration story

**There is no production data to migrate.** The only database the bot has
ever had is Google Sheets; the Postgres database held test fixtures. This
is a fresh schema: one initial migration that creates every table from
nothing.

| | |
|---|---|
| Migration | `db/migrations/0000_initial_sqlite_schema.sql` — 46 tables, 30 unique constraints, 17 check constraints, 15 foreign keys |
| Old Postgres migrations | **Deleted.** SQLite's DDL differs; they could not be reused. |
| How it is applied | `db/client.ts` calls `db/migrate.ts` → `applyMigrations()` while the module loads, **before a single query runs**. |
| On failure | The error is logged and re-thrown. The bot refuses to start rather than run against a schema it does not understand. |
| Applying it twice | Safe. The runner records what it applied in `__drizzle_migrations` and skips the rest. (Tested.) |
| `npm run db:migrate` | Still works — `drizzle-kit migrate` and the boot runner share the `__drizzle_migrations` table. (Verified: `drizzle-kit migrate` then the boot runner leaves 46 tables, no double application.) |
| Where the SQL is read from | `PROJECT_ROOT/db/migrations`, **not** `dist/db/migrations` — `tsc` does not copy `.sql` files into the build output, and the release keeps the folder. |

`drizzle.config.ts` now points at `dialect: "sqlite"`. It sets
`DB_DRIVER` from `DB_MIGRATION_DRIVER` before the schema is loaded, so a
future Postgres migration folder can be generated without editing the file.

### Where the database file lives

`DB_FILE` is the whole configuration. `file:` URLs and plain paths are both
accepted; a relative path is resolved against the project root.

**The default is `data/quotient.db` under the project root — fine for
development, wrong for production.** The production path is
`/opt/openship/data/app.db`, and `docs/DEPLOY.md` already says so. The
deploy clones into a *new* release directory and swaps the service, so a
database file inside the release tree is deleted on every deploy.

Under a test runner every worker gets its own file
(`data/test-<worker>.db`), because the workers run in parallel and SQLite
serialises its writers. `data/` is now in `.gitignore`.

---

## 5. The module sites that must change

The module port is **already in flight** in the working tree: `slots`,
`scrims`, `tourneys`, `community` and `moderation` have been ported to the
join tables and their names match this schema. What is left is below.

Line numbers are as of this report; anchor on the fragment.

### 5.1 `modules/premium/repo.ts` — 62 type errors, the biggest one

| # | Line | Current | Becomes |
|---|---|---|---|
| 1 | 26 | `import type { NodePgDatabase } from "drizzle-orm/node-postgres";` | delete |
| 2 | 54 | `export type DbExecutor = NodePgDatabase<typeof schema>;` | `export type { DbExecutor } from "../../db/client.js";` — `db/client.ts` already exports it, and a drizzle transaction *is* a `DbExecutor` (verified by a type probe) |
| 3 | 427 | `.for("update")` in `lockGuildSettings` | delete the `.for("update")` call. SQLite has no row locks. The lock is belt-and-braces: the real protection is the conditional `UPDATE … WHERE status = 'pending'` in the grant. Replace it with an in-process mutex (a promise chain keyed by `guildId`) if the "extend an existing subscription" path still needs serialising. |
| 4 | 719 | `.for("update")` in `withLockedTransaction` | delete the `.for("update")` call. The `SELECT` becomes a plain read; the conditional `UPDATE` that flips `pending` → `paid` is what makes two concurrent webhooks safe. Add the in-process mutex here too. |

`db/client.ts` exports `DbExecutor` and `Transaction` for exactly this:

```ts
export type DbExecutor = BaseSQLiteDatabase<"async", ResultSet, typeof schema> & {
  execute: typeof execute;
};
```

### 5.2 `modules/identity/repo.ts` — 5 type errors, the `keywords` array

| # | Line | Current | Becomes |
|---|---|---|---|
| 1 | 23 | `import type { PgUpdateSetSource } from "drizzle-orm/pg-core";` | `import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";` |
| 2 | 419 | `keywords: ssConfigs.keywords,` (in `ssConfigColumns`) | remove the column from the map; read the keywords from `ssConfigKeywords` in a second query and fold them into the record |
| 3 | 542 | `keywords: [...input.keywords],` (in the `insert(ssConfigs)`) | remove it from the insert; after the insert, write one `ssConfigKeywords` row per keyword |
| 4 | 587 | `const values: PgUpdateSetSource<typeof ssConfigs> = {};` | `const values: SQLiteUpdateSetSource<typeof ssConfigs> = {};` |
| 5 | 594 | `if (patch.keywords !== undefined) values.keywords = [...patch.keywords];` | remove it from the `set`; write the keyword rows separately (delete the old ones, insert the new ones) |

`ssConfigKeywords` is already in the schema: `ss_config_keywords(ss_config_id,
keyword)`, unique on `(ss_config_id, keyword)`, `ON DELETE CASCADE` from
`ss_configs`.

### 5.3 `modules/community/test-db.ts` — the boot migration broke it

This file generates the area's DDL from `db/schema.ts` and runs it. The
tables now already exist, because the client applies the migration when it
is imported.

```
Error: SQLITE_ERROR: table `jobs` already exists
```

**Fix:** delete the `await createAreaTables()` call (and, if you like, the
whole DDL-generation machinery). The boot migration has already created
the schema in the in-memory database the file opens.

### 5.4 The error codes in the module tests

The module tests assert Postgres SQLSTATEs (`23505` for a unique
violation, `23514` for a check violation). SQLite reports an extended code
instead:

| Constraint | SQLite `extendedCode` |
|---|---|
| unique index | `SQLITE_CONSTRAINT_UNIQUE` |
| primary key | `SQLITE_CONSTRAINT_PRIMARYKEY` |
| check | `SQLITE_CONSTRAINT_CHECK` |

Drizzle wraps the driver's error, so the code is on `error.cause`. The
helper in `db/schema.test.ts` does exactly this — copy it.

### 5.5 `db/client.ts` — a busy timeout **and** a write queue (done)

SQLite has one writer. `modules/slots/repo.ts` already retries on
`SQLITE_BUSY`, but the central fix belongs in the client: a busy
timeout on every connection libsql opens, so a write waits instead of
failing.

**Done, and more than the timeout.** The timeout is set on the client
(`timeout: 5000`), so the driver applies it to *every* connection it
opens — a `PRAGMA busy_timeout` would only reach the one connection
that happened to run it.

**The timeout is not enough.** It makes a contended *statement* wait.
It does nothing for a statement that collides with an **open
transaction** on another connection: that transaction holds the write
lock for its whole body, and the loser of the race is refused by the
*driver* with `SQLITE_BUSY` rather than by the *constraint* it
violated. So `db/write-queue.ts` adds one queue in front of every write
in the process — see `db/QUEUE-REPORT.md`.

---

## 6. The packages

**Add (runtime):**

```
"@libsql/client": "^0.18.0"
```

**Remove:**

```
"pg": "^8.23.1"
"@types/pg": "^8.23.1"
```

**Unchanged:** `drizzle-orm` ^0.45.4, `drizzle-kit` ^0.31.11.

`@libsql/client` pulls in `@libsql/core`, `@libsql/hrana-client`,
`@libsql/isomorphic-ws` and the platform binding (`@libsql/linux-x64-gnu`).
The lock file has to be committed and in sync — the deploy runs `npm ci`.

**`.env.example` needs two new lines** (it is yours):

```
DB_DRIVER=sqlite
DB_FILE=file:./data/quotient.db
```

---

## 7. What is left to do to support Postgres later

The point of the seam is that a Postgres run is a configuration change, not
a rewrite. It is not there yet. The remaining work:

1. **Write the Postgres DDL in `db/dialect.ts`.** Every helper already has
   a Postgres *branch*; what is missing is the DDL inside it. `idCol` needs
   `uuid` with `default gen_random_uuid()` instead of the application's
   `crypto.randomUUID()`; the boolean and JSON defaults have to be written
   the way Postgres wants them (`true`/`false`, `'{}'::jsonb`).
2. **Generate a Postgres migration folder.** `DB_MIGRATION_DRIVER=postgres
   npx drizzle-kit generate --out db/migrations-postgres`. The two folders
   cannot share a `meta/_journal.json`.
3. **Give the runner a second folder.** `db/migrate.ts` points at one
   folder; it has to pick by `DB_DRIVER`.
4. **Give the client a second connection.** `db/client.ts` opens a local
   libsql file; the Postgres branch needs `pg.Pool` and
   `drizzle-orm/node-postgres` back.
5. **Re-run the tests against Postgres.** `db/schema.test.ts` asserts
   SQLite's extended error codes; a Postgres run needs the SQLSTATE
   equivalents.
6. **The raw SQL in the modules must be dialect-neutral.** All of it is
   already fixed for SQLite (`lower(col) LIKE lower(?)`, timestamps
   computed in the app, the array overlaps turned into joins, the
   `SELECT … FOR UPDATE` turned into a conditional `UPDATE` plus a mutex).
   Those spellings work on Postgres too, but the Postgres run has to prove
   it.

**Nothing in `db/schema/*.ts` has to change.** That is the whole point of
the seam, and it is the reason the port is a port and not a rewrite.
