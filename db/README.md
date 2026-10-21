# `db/` — the SQL layer

`repo/` is the Google Sheets layer. `db/` is the SQL layer. Two
directories, two meanings, no confusion (D31).

Nothing outside `db/` writes DDL. Modules import the table objects from
`db/schema.ts` and use drizzle's query builder; they never spell out SQL
that changes the shape of a table.

**The engine is SQLite.** The bot runs on a 1-CPU, 2 GB VPS, and a
Postgres server does not fit in that. The schema is written in a
dialect-neutral subset of SQL, and `db/dialect.ts` is the only file in the
codebase that knows which engine is in use.

The schema itself is ratified in
[`docs/porting/schema.md`](../docs/porting/schema.md). That document
describes the *shape*; this one describes the *dialect*.

---

## Layout

| File | What it holds |
|---|---|
| `db/dialect.ts` | **The seam.** The column and table helpers, the one file that knows whether the engine is SQLite or Postgres. |
| `db/schema.ts` | The single entry point. Re-exports every table so drizzle-kit and the modules read the same definitions. |
| `db/schema/common.ts` | The closed unions the CHECK constraints are generated from, and `oneOfCheck`. |
| `db/schema/esports.ts` | Scrims, slots, tourneys and their children. |
| `db/schema/identity.ts` | Screenshot verification, tag checks, easy tags. |
| `db/schema/premium.ts` | Plans, purchases, entitlements. |
| `db/schema/system.ts` | Guild and user settings, the scheduler, the utility tables. |
| `db/client.ts` | The libsql client, the drizzle instance, `withTransaction`, `closeDatabase`. |
| `db/write-queue.ts` | The write queue. One queue, in front of every write in the process. |
| `db/migrate.ts` | The boot migration runner. |
| `db/seed.ts` | The premium plan catalogue. |
| `db/retention.ts` | The `command_usage` prune. |
| `db/schema.test.ts` | The test. It creates a temporary SQLite database and drops it with the run. |
| `db/write-queue.test.ts` | The test for the queue. It proves a contended write is answered by the constraint and not by the driver. |
| `db/migrations/` | Generated SQL. Never hand-edit it. |

---

## The write queue

**SQLite has one writer.** The libsql driver gives a transaction a
connection of its own, so two writes that overlap in this process do not
queue — they collide, and the second one is refused by the **driver**
with `SQLITE_BUSY` rather than by the **database** with the constraint
it violated. The loser of a race has to be told "already locked", not
"database busy": only the first of those is an answer a caller can act
on.

`db/write-queue.ts` is one queue, in front of every write in the
process. It does not decide who wins a race — the unique constraints
are still the authority. It only makes two statements *reach* the
database one after the other, so the loser gets the constraint's error.

| | |
|---|---|
| **Where it sits** | It wraps the libsql client, so it is in front of every statement: the query builders, the raw statements, the migrations, the seed, the retention prune and the scheduler's deletes. No module has to know that it exists. |
| **What is queued** | The writes. A statement is a write unless its first keyword is `select`, `pragma`, `explain` or `values`. |
| **What is not queued** | The reads. A read must not wait behind a long write, or the whole bot stalls behind one slow transaction. |
| **The transaction is the unit** | A transaction holds the write lock for its whole body, so it holds the queue for its whole body too. Everything inside it runs on its own connection, without going back through the queue — otherwise the transaction would wait for itself. |
| **It is re-entrant** | A transaction's body calls repository functions that write. Those writes are part of the transaction: an `AsyncLocalStorage` carries the open transaction through the async call chain, so a write issued anywhere inside the body finds the transaction it belongs to. A write from *outside* the body is not dragged into it. |
| **The context is entered and exited** | The context holds a **scope**: a box that is filled in when the transaction opens and emptied when the transaction finishes. A write that finds an empty scope is an ordinary write and is queued like one, so the chain that opened the transaction is never left holding a transaction that has closed. |
| **A transaction inside a transaction** | It cannot take the queue — the outer transaction is holding it — so it becomes a savepoint on the same connection. It does not enter a scope of its own: the scope in the context is the parent's, and a second one would shadow it. |

**There is no busy timeout.** The driver can be told to wait for the
writer lock, and it was the wrong answer. The timeout is applied to
*every* connection the driver opens, so it covers the connection a
transaction is given — the one that already holds the write lock. Two
transactions that overlap in one process then stall for the whole
timeout, and one of them fails with `SQLITE_BUSY` anyway: a slow
failure instead of a fast one. One writer at a time is what SQLite
needs, and the queue is what makes that true by construction. Nothing
else writes the file — the bot applies its own migrations at boot, and
the deploy pipeline has no migration step — so there is no second
process to wait for either.

---

## The seam: `db/dialect.ts`

Every column is built by a helper, and every helper has one branch per
dialect. The schema files call the helpers and never import
`drizzle-orm/sqlite-core` or `drizzle-orm/pg-core`.

| Helper | SQLite | Postgres | The application sees |
|---|---|---|---|
| `textCol(name)` | `text` | `text` | `string` |
| `intCol(name)` | `integer` | `integer` | `number` |
| `smallIntCol(name)` | `integer` | `smallint` | `number` |
| `boolCol(name)` | `integer` 0/1 | `boolean` | `boolean` |
| `jsonCol<T>(name, default?)` | `text` holding JSON | `jsonb` | `T` |
| `tsCol(name)` | `integer`, epoch ms | `timestamptz` | `Date` |
| `idCol(name?)` | `text` + `crypto.randomUUID()` | `uuid` + `gen_random_uuid()` | `string` |
| `serialIdCol(name?)` | `integer primary key autoincrement` | `bigserial` | `number` |
| `createdAtCol(name?)` | `integer`, filled in the app | `timestamptz`, filled in the app | `Date` |
| `updatedAtCol(name?)` | as above, plus `$onUpdate` | as above | `Date` |
| `defineTable(name, columns, extra?)` | `sqliteTable` | `pgTable` | the table |
| `index` / `unique` / `uniqueIndex` / `check` / `primaryKey` | the SQLite builders | the Postgres builders | the constraint |

`foreignIdCol(name)` is `textCol(name)` under another name: a foreign key to
an `idCol` primary key. It exists so that a uuid reference can never drift
into a numeric column by accident.

**The active dialect** is `DB_DRIVER=sqlite` (the default) or
`DB_DRIVER=postgres`. It is read once, at module load, because the schema
objects are built once.

**The one deliberate lie.** The *types* of the helpers are modelled on the
SQLite builders, because SQLite is the dialect that ships; the Postgres
branch casts its builders to the same types. That keeps one set of types
for the schema, the modules and the tests. The cast is confined to
`db/dialect.ts` — nothing above `db/` can tell the difference, which is
the entire point.

**Timestamps are computed in the application.** `now()` means something
different on the two engines, and `created_at` / `updated_at` are filled in
by drizzle's `$defaultFn` and `$onUpdate`, so the same code produces the
same value on both.

**Booleans are mapped by the driver.** SQLite's `integer` column with
`mode: "boolean"` reads 0/1 as `false`/`true` and writes them back the
same way, so the application never sees an integer where it expects a
boolean. No smallint-and-map-it-in-the-app is needed.

---

## What is left to do for Postgres

The point of the seam is that a future Postgres run is a *configuration
change*. It is not there yet. The remaining work is:

1. **Write the Postgres branch of each helper in `db/dialect.ts`.** Most of
   them are already written — `textCol`, `intCol`, `smallIntCol`,
   `boolCol`, `jsonCol`, `tsCol`, `idCol`, `serialIdCol`,
   `createdAtCol`, `updatedAtCol`, `defineTable` and the five constraint
   builders all have a Postgres branch today. What is *not* written is the
   Postgres **DDL**: the `idCol` branch needs `uuid` with
   `default gen_random_uuid()` rather than the application's
   `crypto.randomUUID()`, and the boolean and JSON defaults have to be
   written the way Postgres wants them.
2. **Generate a Postgres migration folder.** `drizzle.config.ts` already
   has the switch: `DB_MIGRATION_DRIVER=postgres npx drizzle-kit generate
   --out db/migrations-postgres`. The two folders cannot share a
   `meta/_journal.json`, so the Postgres one needs its own output
   directory and its own `MIGRATIONS_FOLDER` in `db/migrate.ts`.
3. **Give the runner a second folder.** `db/migrate.ts` points at one
   folder; it needs to pick the folder by `DB_DRIVER`.
4. **Give the client a second connection.** `db/client.ts` opens a local
   libsql file. The Postgres branch needs `pg.Pool` and
   `drizzle-orm/node-postgres` back — which is what the file did before
   this port.
5. **Check the raw SQL.** Six statements in the feature modules spell
   Postgres out loud (`now()`, `ILIKE`, `ARRAY[…]`, `&&`, `for update`).
   They are listed in the porting report; they have to be rewritten for
   the dialect-neutral subset before a Postgres run is possible.
6. **Re-run the tests against Postgres.** `db/schema.test.ts` asserts
   SQLite's extended error codes; a Postgres run needs the SQLSTATE
   equivalents.

None of that touches the schema files or the feature modules, which is
the point.

---

## Running the migrations

```bash
npm run db:generate   # writes db/migrations/<n>_<name>.sql from the schema
npm run db:migrate    # applies every pending migration
npm run db:studio     # opens the drizzle studio
```

`drizzle.config.ts` reads `DB_FILE` from the project `.env`.

**The bot applies its own migrations at boot.** `db/client.ts` calls
`applyMigrations()` while the module is loading, before a single query
runs, and a migration that cannot be applied is a fatal error: the bot
refuses to start rather than run against a schema it does not understand.
The deploy pipeline has no separate migration step, and that is
deliberate — the schema and the code can never disagree.

Applying the migration twice is safe. The runner records what it has
applied in a `__drizzle_migrations` table and skips the rest.

**Never edit a migration file.** Change the schema and regenerate.

### There is no data to migrate

The only database the bot has ever had is Google Sheets. The Postgres
database that existed during development holds test fixtures and nothing
else. This is a **fresh schema**, not a data migration: the first
migration creates every table from nothing, and there is no step that
reads the old database and writes the new one.

---

## Where the database file lives

`DB_FILE` is the whole configuration.

| Value | Meaning |
|---|---|
| unset | `data/quotient.db` under the project root — fine for development, **wrong for production** |
| `file:/opt/openship/data/app.db` | a libsql URL, used verbatim |
| `/opt/openship/data/app.db` | an absolute path |
| `data/app.db` | a path relative to the project root |
| `:memory:` | an in-memory database, for tests |

**In production the file must be outside the release directory.** The
deploy clones into a *new* release folder and swaps the service; a
database file that travels with the release is a database that is thrown
away on every deploy. The production path is
`/opt/openship/data/app.db`, and `docs/DEPLOY.md` has the runbook.

---

## Conventions

These hold everywhere, and the helpers in `db/dialect.ts` are what make
them hold.

- **Primary key.** `id` is a `text` uuid generated in the application by
  `crypto.randomUUID()`, with one exception: `command_usage` uses an
  auto-incrementing integer. It is the only high-write table and nothing
  references its id (S1).
- **Discord ids are `text`.** Snowflakes exceed `Number.MAX_SAFE_INTEGER`,
  so a numeric column would silently round them.
- **Timestamps are instants.** Stored as epoch milliseconds on SQLite and
  as `timestamptz` on Postgres; the IST offset is applied when something
  is rendered for a human (S9 / D30).
- **Column names are snake_case** and close to the source's, so a ported
  query reads the same (S4).
- **Enums are `text` with a CHECK.** The closed union lives in
  `db/schema/common.ts`; the TS type is derived from it and the constraint
  is generated from it, so they cannot drift (S5).
- **Every table has `created_at` and `updated_at`.** `updated_at` is
  bumped by drizzle on write; a hand-written `UPDATE` has to set it
  itself.
- **No arrays.** SQLite has none, so every list of ids is a join table.
  Postgres ends up with the same shape, which is why the two dialects
  agree.

---

## Tables

46 tables. Grouped by area.

### Esports

| Table | One line |
|---|---|
| `scrims` | A scrim registration: its channels, its schedule, its slot range, its embed templates. |
| `scrim_open_days` | The weekdays a scrim may be opened on. One row per (scrim, weekday). |
| `scrim_autoclean` | What the autoclean pass removes. One row per (scrim, kind). |
| `slots` | One row per scrim slot, always — a free slot is a row with `state='free'`, not a missing row (D14). |
| `slot_members` | The team that holds a slot. One row per (slot, member). |
| `reserved_slots` | Slots a host set aside for somebody before registration opened. Belongs to one scrim. |
| `reserved_slot_members` | The members a reserved slot was reserved for. |
| `banned_teams` | Teams banned from a scrim, with the members so the ban survives a rename. |
| `banned_team_members` | The members of a banned team. |
| `ban_logs` | The channel a guild's ban log is written to. One per guild. |
| `slot_reminders` | "Tell me when a slot frees up" — one row per (scrim, user). |
| `slot_managers` | The public "cancel / claim a slot" panel. |
| `slot_manager_scrims` | Which scrims a slot manager shows. A real join table — the relation is many-to-many. |
| `tourneys` | A tournament registration: its channels, its group size, its schedule. |
| `tourney_slots` | A registered team in a tournament, with a per-tourney position `num` (D25). |
| `tourney_slot_members` | The members of a registered tournament team. |
| `tourney_banned_users` | Users banned from a tournament. A join table, not an array — `ARRAY_APPEND` races. |
| `media_partners` | A media-partner channel attached to a tournament. |
| `media_partner_slots` | A team that registered through a media-partner channel. |
| `media_partner_slot_members` | The members of a media-partner registration. |
| `tourney_group_lists` | A published standings board for one group. The channel id is stored on the row. |

### Identity and verification

| Table | One line |
|---|---|
| `ss_configs` | A screenshot-verification configuration: one channel, one flavour of screenshot, one role to grant. |
| `ss_config_keywords` | The words a custom screenshot must contain. One row per (configuration, keyword). |
| `ss_submissions` | One submitted screenshot, belonging to exactly one config (D13). |
| `tagcheck_channels` | A channel where a clan tag is checked on every message. |
| `easytag_channels` | A channel where members are asked to tag their clan. |

### Premium

| Table | One line |
|---|---|
| `premium_plans` | The plan catalogue. `duration_days` is an integer, never an `INTERVAL`. |
| `premium_transactions` | One purchase. `plan_id` is nullable with `ON DELETE SET NULL`; `plan_snapshot` keeps the receipt readable. |
| `guild_entitlements` | One row per (guild, feature). The pair **is** the primary key (D15). |

### System

| Table | One line |
|---|---|
| `guild_settings` | Per-guild runtime state: prefix, embeds, lockdown switch, premium expiry. |
| `user_settings` | Per-user state: premium flags and the balance. |
| `jobs` | The durable scheduler. A row is a scheduled event; `user_id` is a column, not a JSON path. |
| `command_usage` | One row per command invocation. The one serial-id table. Pruned after 30 days (S10). |
| `tags` | A canned message a guild can post with a short command. |
| `alerts` | An announcement shown to every user until it is read. |
| `alert_prompts` | A time a user was prompted to read an alert. |
| `alert_reads` | A record that a user read an alert. |
| `snipes` | The last deleted message of a channel, for the `snipe` command. |
| `votes` | A user's vote profile. |
| `blocklist` | The global block list, keyed by (id, kind). |
| `lockdowns` | A guild or a set of channels that are locked until lifted or expired. |
| `lockdown_channels` | The channels a lockdown covers. |
| `lockdown_maintenance_channels` | The maintenance channels the bot created for a lockdown. |
| `autopurge_configs` | A channel whose messages are deleted automatically. |
| `autorole_configs` | The roles automatically given to new members. |
| `autorole_roles` | The roles an auto-role config gives out. One row per (guild, kind, role). |

---

## Constraints

### Unique

The source enforced these in application code by reading then writing, which
races. Every one is a database constraint (S5).

| Table | Constraint |
|---|---|
| `scrims` | unique `registration_channel_id` |
| `scrim_open_days` | unique `(scrim_id, day)` |
| `scrim_autoclean` | unique `(scrim_id, kind)` |
| `slots` | unique `(scrim_id, num)` |
| `slot_members` | unique `(slot_id, user_id)` |
| `tourney_slots` | unique `(tourney_id, num)` |
| `tourney_slot_members` | unique `(tourney_slot_id, user_id)` |
| `tourneys` | unique `registration_channel_id` |
| `tourney_group_lists` | unique `message_id`, unique `(tourney_id, group_number)` |
| `tags` | unique `(guild_id, name)` |
| `ss_configs` | unique `channel_id` |
| `ss_config_keywords` | unique `(ss_config_id, keyword)` |
| `tagcheck_channels` | unique `channel_id` |
| `easytag_channels` | unique `channel_id` |
| `ban_logs` | unique `guild_id` |
| `slot_managers` | unique `main_channel_id` |
| `autorole_configs` | unique `guild_id` |
| `autorole_roles` | unique `(guild_id, kind, role_id)` |
| `autopurge_configs` | unique `channel_id` |
| `snipes` | unique `channel_id` |
| `guild_settings` | unique `guild_id` |
| `user_settings` | unique `user_id` |
| `premium_plans` | unique `name` (and unique `code`, the upsert key) |
| `premium_transactions` | unique `txn_id` |
| `slot_manager_scrims` | unique `(slot_manager_id, scrim_id)`, unique `scrim_id` |
| `slot_reminders` | unique `(scrim_id, user_id)` |
| `reserved_slots` | unique `(scrim_id, num)` |
| `reserved_slot_members` | unique `(reserved_slot_id, user_id)` |
| `banned_teams` | unique `(scrim_id, user_id)` |
| `banned_team_members` | unique `(banned_team_id, user_id)` |
| `tourney_banned_users` | unique `(tourney_id, user_id)` |
| `media_partners` | unique `channel_id` |
| `media_partner_slot_members` | unique `(media_partner_slot_id, user_id)` |
| `blocklist` | unique `(block_id, block_id_type)` |
| `votes` | unique `user_id` |
| `alert_reads` | unique `(alert_id, user_id)` |
| `lockdowns` | unique `lock_key` |
| `lockdown_channels` | unique `(lockdown_id, channel_id)` |
| `lockdown_maintenance_channels` | unique `(lockdown_id, channel_id)` |
| `guild_entitlements` | primary key `(guild_id, feature)` |

`alerts` has a **partial** unique index: `CREATE UNIQUE INDEX
alerts_active_unique ON alerts (active) WHERE active` — only one alert is
live at a time. SQLite supports partial indexes, so it works on both
dialects.

### Check

| Column | Allowed values |
|---|---|
| `scrims.status` | `draft`, `open`, `closed` |
| `tourneys.status` | `draft`, `open`, `paused`, `closed` |
| `slots.state` | `free`, `claimed`, `locked`, `banned` |
| `jobs.event` | the sixteen scheduler event names |
| `ss_configs.ss_type` | `youtube`, `instagram`, `rooter`, `loco`, `any_ss`, `custom` |
| `lockdowns.type` | `channel`, `guild`, `category`, `maintenance` |
| `blocklist.block_id_type` | `1` = user, `2` = guild |
| `guild_entitlements.feature` | the seven entitlement features |
| `guild_entitlements.source` | `premium`, `owner`, `manual` |
| `premium_transactions.status` | `pending`, `paid`, `failed` |
| `scrim_open_days.day` | the seven weekday names |
| `scrim_autoclean.kind` | `channel`, `role` |
| `autorole_roles.kind` | `human`, `bot` |
| `guild_settings.prefix` | `length(prefix) <= 5` |
| `slots` | a `claimed` slot must have an `owner_user_id` |

### Foreign keys

Every FK declares `ON DELETE` explicitly. `CASCADE` for owned children,
`SET NULL` for `premium_transactions.plan_id`. The source had zero
ordinary FKs, which is why orphans are everywhere.

---

## The slot claim

The single highest-value behaviour in the port (D14 / S7). Quotient
protected the same operation with a module-global `asyncio.Lock` that does
not survive a restart or a second process, so two users could end up as
owners of one slot. The database enforces the invariant instead.

```sql
UPDATE slots
   SET state = 'claimed', team_name = ?, owner_user_id = ?
 WHERE scrim_id = ? AND num = ? AND state = 'free'
 RETURNING id;
```

Zero rows returned ⇒ somebody else took it. The team members go into
`slot_members` in the same transaction.

The cancel, which only the owner can do:

```sql
UPDATE slots
   SET state = 'free', team_name = NULL, owner_user_id = NULL
 WHERE id = ? AND owner_user_id = ?;
```

How many are free — a count, not a read-modify-write:

```sql
SELECT count(*) FROM slots WHERE scrim_id = ? AND state = 'free';
```

In drizzle:

```ts
import { sql } from "drizzle-orm";
import { slots } from "./db/schema.js";

const claimed = await db
  .update(slots)
  .set({ state: "claimed", teamName, ownerUserId })
  .where(sql`${slots.scrimId} = ${scrimId} and ${slots.num} = ${num} and ${slots.state} = 'free'`)
  .returning({ id: slots.id });

if (claimed.length === 0) {
  // Somebody else won the race.
}
```

`db/schema.test.ts` proves this against a real database: it asserts that
the second claim updates zero rows and that the surviving row still belongs
to the first claimant.

---

## The premium plan catalogue

`db/seed.ts` holds the five plans Quotient sold, ported exactly. It is
**upserted**, not reseeded:

```ts
await db
  .insert(premiumPlans)
  .values(PREMIUM_PLAN_CATALOGUE)
  .onConflictDoUpdate({
    target: premiumPlans.code,
    set: {
      name: excluded(premiumPlans.name),
      description: excluded(premiumPlans.description),
      price: excluded(premiumPlans.price),
      durationDays: excluded(premiumPlans.durationDays),
      updatedAt: new Date(),
    },
  });
```

Quotient's `insert_plans()` deleted and re-inserted the catalogue on every
startup, which destroyed the paid transactions that referenced a plan row.
An upsert leaves a plan that was removed from the catalogue alone, so its
transactions still resolve — and the receipt reads `plan_snapshot` anyway.

---

## Tests

```bash
npm test
```

`db/schema.test.ts` opens a **temporary SQLite file database**, applies the
migration to it, and drops it when the run ends. It needs no server and
no running bot. It asserts the table list, the primary-key strategy, that
Discord ids are text, that timestamps are epoch milliseconds, the unique
and CHECK constraints (by SQLite's extended error code), the slot claim,
the foreign-key cascade, the partial unique index, and that applying the
migration twice is safe.

`db/write-queue.test.ts` does the same with the queue: it asserts that
two overlapping writes are answered by the **constraint** and not by
`SQLITE_BUSY`, that a write outside an open transaction waits its turn
instead of colliding, that a transaction body may write through the
database handle without deadlocking against itself, and that the loser
of a race is still told "already locked".
