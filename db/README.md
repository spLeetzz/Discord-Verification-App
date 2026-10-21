# `db/` — the Postgres layer

`repo/` is the Google Sheets layer. `db/` is the Postgres layer. Two
directories, two meanings, no confusion (D31).

Nothing outside `db/` writes DDL. Modules import the table objects from
`db/schema.ts` and use drizzle's query builder; they never spell out SQL
that changes the shape of a table.

The schema is ratified in [`docs/porting/schema.md`](../docs/porting/schema.md).
This file is the working reference for it.

---

## Layout

| File | What it holds |
|---|---|
| `db/schema.ts` | The single entry point. Re-exports every table so drizzle-kit and the modules read the same definitions. |
| `db/schema/common.ts` | Column builders (`primaryId`, `discordId`, `createdAt`, …) and the closed unions that the CHECK constraints are generated from. |
| `db/schema/esports.ts` | Scrims, slots, tourneys and their children. |
| `db/schema/identity.ts` | Screenshot verification, tag checks, easy tags. |
| `db/schema/premium.ts` | Plans, purchases, entitlements. |
| `db/schema/system.ts` | Guild and user settings, the scheduler, the utility tables. |
| `db/client.ts` | The `pg` pool, the drizzle instance, `withTransaction`, `closeDatabase`. |
| `db/seed.ts` | The premium plan catalogue. |
| `db/retention.ts` | The `command_usage` prune. |
| `db/schema.test.ts` | The live-database test. It asserts the table list, the primary keys, the constraints and the slot claim. |
| `db/migrations/` | Generated SQL. Never hand-edit it. |

---

## Running the migrations

```bash
npm run db:generate   # writes db/migrations/<n>_<name>.sql from the schema
npm run db:migrate    # applies every pending migration
npm run db:studio     # opens the drizzle studio
```

`drizzle.config.ts` reads `DATABASE_URL` from the project `.env`; the default
is `postgres://bssa:bssa@localhost:5433/bssa`, which is the container in
`docker-compose.yml`.

To start from an empty database:

```bash
docker exec bssa-postgres psql -U bssa -d bssa -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
rm -rf db/migrations
npm run db:generate
npm run db:migrate
```

Never edit a migration file. Change the schema and regenerate.

---

## Conventions

These hold everywhere, and the helpers in `db/schema/common.ts` are what
make them hold.

- **Primary key.** `id uuid primary key default gen_random_uuid()` on every
  table, with one exception: `command_usage` uses `bigserial`. It is the
  only high-write table and nothing references its id (S1).
- **Discord ids are `text`.** Snowflakes exceed `Number.MAX_SAFE_INTEGER`, so
  a `bigint` would silently round them. Arrays of ids are `text[]` (S2).
- **Timestamps are `timestamptz`.** The database stores instants; IST is a
  presentation concern (S9 / D30).
- **Column names are snake_case** and close to the source's, so a ported
  query reads the same (S4).
- **Enums are `text` with a CHECK.** The closed union lives in
  `db/schema/common.ts`; the TS type is derived from it and the constraint is
  generated from it, so they cannot drift (S5).
- **Every table has `created_at` and `updated_at`.** `updated_at` is bumped
  by drizzle on write; a hand-written `UPDATE` has to set it itself.

---

## Tables

35 tables. Grouped by area.

### Esports

| Table | One line |
|---|---|
| `scrims` | A scrim registration: its channels, its schedule, its slot range, its embed templates. |
| `slots` | One row per scrim slot, always — a free slot is a row with `state='free'`, not a missing row (D14). |
| `reserved_slots` | Slots a host set aside for somebody before registration opened. Belongs to one scrim. |
| `banned_teams` | Teams banned from a scrim, with the members so the ban survives a rename. |
| `ban_logs` | The channel a guild's ban log is written to. One per guild. |
| `slot_reminders` | "Tell me when a slot frees up" — one row per (scrim, user). |
| `slot_managers` | The public "cancel / claim a slot" panel. |
| `slot_manager_scrims` | Which scrims a slot manager shows. A real join table — the relation is many-to-many. |
| `tourneys` | A tournament registration: its channels, its group size, its schedule. |
| `tourney_slots` | A registered team in a tournament, with a per-tourney position `num` (D25). |
| `tourney_banned_users` | Users banned from a tournament. A join table, not an array — `ARRAY_APPEND` races. |
| `media_partners` | A media-partner channel attached to a tournament. |
| `media_partner_slots` | A team that registered through a media-partner channel. |
| `tourney_group_lists` | A published standings board for one group. The channel id is stored on the row. |

### Identity and verification

| Table | One line |
|---|---|
| `ss_configs` | A screenshot-verification configuration: one channel, one flavour of screenshot, one role to grant. |
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
| `command_usage` | One row per command invocation. The one `bigserial` table. Pruned after 30 days (S10). |
| `tags` | A canned message a guild can post with a short command. |
| `alerts` | An announcement shown to every user until it is read. |
| `alert_prompts` | A time a user was prompted to read an alert. |
| `alert_reads` | A record that a user read an alert. |
| `snipes` | The last deleted message of a channel, for the `snipe` command. |
| `votes` | A user's vote profile. |
| `blocklist` | The global block list, keyed by (id, kind). |
| `lockdowns` | A guild or a set of channels that are locked until lifted or expired. |
| `autopurge_configs` | A channel whose messages are deleted automatically. |
| `autorole_configs` | The roles automatically given to new members. |

---

## Constraints

### Unique

The source enforced these in application code by reading then writing, which
races. Every one is a database constraint (S5).

| Table | Constraint |
|---|---|
| `scrims` | unique `registration_channel_id` |
| `slots` | unique `(scrim_id, num)` |
| `tourney_slots` | unique `(tourney_id, num)` |
| `tourneys` | unique `registration_channel_id` |
| `tourney_group_lists` | unique `message_id`, unique `(tourney_id, group_number)` |
| `tags` | unique `(guild_id, name)` |
| `ss_configs` | unique `channel_id` |
| `tagcheck_channels` | unique `channel_id` |
| `easytag_channels` | unique `channel_id` |
| `ban_logs` | unique `guild_id` |
| `slot_managers` | unique `main_channel_id` |
| `autorole_configs` | unique `guild_id` |
| `autopurge_configs` | unique `channel_id` |
| `snipes` | unique `channel_id` |
| `guild_settings` | unique `guild_id` |
| `user_settings` | unique `user_id` |
| `premium_plans` | unique `name` (and unique `code`, the upsert key) |
| `premium_transactions` | unique `txn_id` |
| `slot_manager_scrims` | unique `(slot_manager_id, scrim_id)`, unique `scrim_id` |
| `slot_reminders` | unique `(scrim_id, user_id)` |
| `reserved_slots` | unique `(scrim_id, num)` |
| `banned_teams` | unique `(scrim_id, user_id)` |
| `tourney_banned_users` | unique `(tourney_id, user_id)` |
| `media_partners` | unique `channel_id` |
| `blocklist` | unique `(block_id, block_id_type)` |
| `votes` | unique `user_id` |
| `alert_reads` | unique `(alert_id, user_id)` |
| `guild_entitlements` | primary key `(guild_id, feature)` |

`alerts` has a **partial** unique index: `CREATE UNIQUE INDEX alerts_active_unique
ON alerts (active) WHERE active` — only one alert is live at a time.

### Check

| Column | Allowed values |
|---|---|
| `scrims.status` | `draft`, `open`, `closed` |
| `tourneys.status` | `draft`, `open`, `paused`, `closed` |
| `slots.state` | `free`, `claimed`, `locked`, `banned` |
| `jobs.event` | `reminder`, `msg_delete`, `scrim_open`, `autoclean`, `scrim_match`, `scrim_ban`, `scrim_reserve`, `lockdown`, `user_premium`, `guild_premium`, `vote`, `alert`, `autopurge` |
| `ss_configs.ss_type` | `youtube`, `instagram`, `rooter`, `loco`, `any_ss`, `custom` |
| `lockdowns.type` | `channel`, `guild`, `category`, `maintenance` |
| `blocklist.block_id_type` | `1` = user, `2` = guild |
| `guild_entitlements.feature` | `scrim_slots`, `slot_reminders`, `idp_transfer`, `extra_channels`, `screenshot_types`, `success_message` |
| `guild_entitlements.source` | `premium`, `owner`, `manual` |
| `premium_transactions.status` | `pending`, `paid`, `failed` |
| `scrims.open_days[]` | the seven weekday names (containment check) |
| `scrims.autoclean[]` | `channel`, `role` (containment check) |
| `guild_settings.prefix` | `char_length(prefix) <= 5` |
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
   SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 RETURNING id;
```

Zero rows returned ⇒ somebody else took it.

The cancel, which only the owner can do:

```sql
UPDATE slots
   SET state = 'free', team_name = null, owner_user_id = null, members = '{}'
 WHERE id = $1 AND owner_user_id = $2;
```

How many are free — a count, not a read-modify-write:

```sql
SELECT count(*) FROM slots WHERE scrim_id = $1 AND state = 'free';
```

In drizzle:

```ts
import { sql } from "drizzle-orm";
import { slots } from "./db/schema.js";

const claimed = await db
  .update(slots)
  .set({ state: "claimed", teamName, ownerUserId, members })
  .where(sql`${slots.scrimId} = ${scrimId} and ${slots.num} = ${num} and ${slots.state} = 'free'`)
  .returning({ id: slots.id });

if (claimed.length === 0) {
  // Somebody else won the race.
}
```

`db/schema.test.ts` proves this against the live database: it asserts that
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

`db/schema.test.ts` connects to the real database. It asserts the table
list, the primary-key strategy, that Discord ids are `text`, the unique and
CHECK constraints (by their SQLSTATE — `23505` and `23514`), the slot claim,
and that a paid transaction survives the removal of the plan it points at.

The fixtures use ids no real row can have and are deleted afterwards.
