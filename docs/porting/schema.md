# Ratified target schema

Manager decisions for the Postgres layer. These **supersede** anything in the
wave-1 model inventory that conflicts, and they are what the database
engineer builds.

Read `docs/porting/common.md` first — this file only covers the schema.

---

## S1. Primary keys: uuid v4, with one exception

Every domain table gets `id uuid primary key default gen_random_uuid()`.
Postgres 16 has `gen_random_uuid()` built in; no extension needed.

**Why uuid over bigserial:** ids travel. They appear in Discord `custom_id`s,
in `jobs.payload` JSON, in every future API payload, and in the DOM of a
dashboard that does not exist yet. A uniform opaque string removes the
int-versus-string ambiguity at exactly those boundaries, and one strategy
means nobody has to remember which table used which.

**The exception: `commands` gets `bigserial`.** It is the only high-write
table — one row per command invocation — and its id is never referenced from
anywhere else. The uuid v4 generation plus a 16-byte index entry on the
hottest write path in the database is a cost with no benefit.

Everything else is uuid. Foreign keys match their target.

## S2. Discord IDs are `text`, never `bigint`

Discord snowflakes exceed `Number.MAX_SAFE_INTEGER`. `text` removes the
parse/serialise hazard entirely and makes scalar columns and array columns
(`members text[]`, `humans text[]`) consistent.

Ids are parsed from strings at the boundary and stay strings inside.

## S3. Table names

Clean, no schema prefixes, no dotted names. The source's `sm.scrims` and
`tm.tourney` are Tortoise schema-prefix artifacts with no meaning here, and
dotted identifiers must be quoted in every SQL string forever.

| Purpose | Final name |
|---|---|
| Guild settings | `guild_settings` |
| User settings | `user_settings` |
| Guild entitlements (D15) | `guild_entitlements` |
| Premium plans | `premium_plans` |
| Premium transactions (D37) | `premium_transactions` |
| Scrims | `scrims` |
| Scrim slots (D14) | `slots` |
| Reserved slots | `reserved_slots` |
| Banned teams | `banned_teams` |
| Ban log channel | `ban_logs` |
| Slot reminders | `slot_reminders` |
| Slot managers | `slot_managers` |
| Tourneys | `tourneys` |
| Tourney slots (D25) | `tourney_slots` |
| Tourney banned users | `tourney_banned_users` |
| Media partners | `media_partners` |
| Media partner slots | `media_partner_slots` |
| Published group lists | `tourney_group_lists` |
| Screenshot verification configs | `ss_configs` |
| Screenshot submissions | `ss_submissions` |
| Tag check channels | `tagcheck_channels` |
| Easy tag channels | `easytag_channels` |
| Durable scheduler (D12) | `jobs` |
| Command usage log | `command_usage` |
| Tags | `tags` |
| Snipes | `snipes` |
| Auto-purge configs | `autopurge_configs` |
| Auto-role configs | `autorole_configs` |
| Block list | `blocklist` |
| Lockdowns | `lockdowns` |
| Alerts | `alerts` (plus `alert_prompts`, `alert_reads` if the alerts cog is revived) |

**Note the two renames away from the source:** `timer` → `jobs` ("timer" means
three different things in this codebase already) and `commands` →
`command_usage` (it is a usage log; the source name shadows the word "command"
throughout the feature code).

**The source's dotted names map like this**, for the engineers rewriting the
raw SQL:

| Quotient | Ours |
|---|---|
| `sm.scrims` | `scrims` |
| `sm.assigned_slots` + `sm.scrims_sm.assigned_slots` | `slots` (merged — D14) |
| `sm.reserved_slots` + join table | `reserved_slots` (scrim_id is a column) |
| `sm.banned_teams` + join table | `banned_teams` (scrim_id is a column) |
| `scrims_slot_reminders` + join table | `slot_reminders` (scrim_id is a column) |
| `tm.tourney` | `tourneys` |
| `tm.register` + `tm.tourney_tm.register` | `tourney_slots` (merged — D25) |
| `tm.media_partners` + join table | `media_partners` (tourney_id is a column) |
| `tm.media_partner_users` + join table | `media_partner_slots` (media_partner_id is a column) |
| `tourney_groups` | `tourney_group_lists` |
| `ss_info` | `ss_configs` |
| `ss_data` + `ss_info_ss_data` | `ss_submissions` (ss_config_id is a FK — D13) |
| `tagcheck` | `tagcheck_channels` |
| `easytags` | `easytag_channels` |
| `timer` | `jobs` |
| `commands` | `command_usage` |
| `guild_data` | `guild_settings` |
| `user_data` | `user_settings` |
| `premium_txns` | `premium_transactions` |
| `lockdown` | `lockdowns` |
| `autopurge` | `autopurge_configs` |
| `autoroles` | `autorole_configs` |
| `block_list` | `blocklist` |
| `ptable_*`, `subscriptions*` | **not ported** — orphaned in the source |

**D14 and D25 remove most join tables.** A slot belongs to exactly one scrim
and a tourney slot to exactly one tourney, so the junction carries no
information. The join tables survive only where the relation really is
many-to-many: `tourney_media_partners` (a tourney can have several partner
channels and a channel can be a partner of one tourney), `alert_prompts_link`
and `alert_reads_link`.

## S4. Columns

Every table has `id`, `created_at timestamptz not null default now()`,
`updated_at timestamptz not null default now()`.

Column names are **snake_case** and **close to the source**, so the ported
queries and the future API read the same. The renames from source:

| Source | Ours | Why |
|---|---|---|
| `Scrim.stoggle` | `scrims.enabled` | "stoggle" is a typo of toggle and collides with `slot_managers.toggle`. Two different meanings, two tables. |
| `Scrim.time_elapsed` (text) | `scrims.time_elapsed_seconds` (integer) | a duration, not a sentence. Format at render time. |
| `Tourney.slotlist_start` | `tourneys.slotlist_start` | keep — same concept as `scrims.start_from`, different default. **Both names are wrong.** Use `start_from` for both. |
| `Scrim.autodelete_rejects` | `scrims.autodelete_rejects` | keep |
| `Tourney.autodelete_rejected` | `tourneys.autodelete_rejects` | the source spells it two different ways. Pick one. |
| `Commands.used_at` | `command_usage.created_at` | the source's own timestamp semantics |
| `Timer.created` | `jobs.created_at` | |
| `SSData.submitted_at` | `ss_submissions.created_at` | |
| `Snipe.delete_time` | `snipes.created_at` | the row is created at delete time |
| `Alert.created_at`, `Prompt.prompted_at`, `Read.read_at` | `created_at` on all three | |
| `TGroupList.refresh_at` | `tourney_group_lists.updated_at` | |
| `BlockList.timestamp` | `blocklist.created_at` | |
| `PremiumTxn.created_at` | `premium_transactions.created_at` | |
| `User.made_premium` | **dropped** | records "servers this user boosted" per the comment, but the code appends the user's own id. It is write-only garbage, and the monetisation cluster that would populate it does not ship (D40). |

## S5. Constraints

Every enum-ish column is `text` with a `CHECK` constraint, and the TS union
type sits next to the table. `pgEnum` needs `ALTER TYPE … ADD VALUE`, which
drizzle-kit does not model; a `CHECK` is a plain DDL change and the union type
still gives compile-time exhaustiveness.

| Column | Allowed values |
|---|---|
| `scrims.status` | `draft`, `open`, `closed` (D26) |
| `tourneys.status` | `draft`, `open`, `paused`, `closed` (D26) |
| `slots.state` | `free`, `claimed`, `locked`, `banned` (D14) |
| `jobs.event` | `reminder`, `msg_delete`, `scrim_open`, `autoclean`, `scrim_match`, `scrim_ban`, `scrim_reserve`, `lockdown`, `user_premium`, `guild_premium`, `vote`, `alert`, `autopurge` |
| `ss_configs.ss_type` | `youtube`, `instagram`, `rooter`, `loco`, `any_ss`, `custom` — **note `any_ss`, not `"Any SS"`** — a space and mixed case in a database value is a trap, and nothing external depends on the literal (D37) |
| `lockdowns.type` | `channel`, `guild`, `category`, `maintenance` |
| `blocklist.block_id_type` | `1` = user, `2` = guild |
| `guild_entitlements.feature` | `scrim_slots`, `slot_reminders`, `idp_transfer`, `extra_channels`, `screenshot_types`, `success_message` |
| `premium_transactions.status` | `pending`, `paid`, `failed` (D37) |
| `scrims.open_days[]` | the seven weekday names — as a `text[]` with a containment `CHECK` |
| `scrims.autoclean[]` | `channel`, `role` — same |

**Uniqueness constraints added.** The source enforces these in application
code by reading then writing, which races. Every one becomes a database
constraint:

| Table | Constraint |
|---|---|
| `scrims` | unique `registration_channel_id` |
| `slots` | unique `(scrim_id, num)` |
| `tourney_slots` | unique `(tourney_id, num)` |
| `tourneys` | unique `registration_channel_id` |
| `tourney_group_lists` | unique `message_id`, unique `(tourney_id, group_number)` |
| `tags` | unique `(guild_id, name)` |
| `ss_configs` | unique `channel_id` |
| `ss_submissions` | index `(author_id)`, index `(dhash, phash)` |
| `tagcheck_channels` | unique `channel_id` |
| `easytag_channels` | unique `channel_id` |
| `ban_logs` | unique `guild_id` |
| `slot_managers` | unique `main_channel_id` |
| `autorole_configs` | unique `guild_id` |
| `autopurge_configs` | unique `channel_id` |
| `snipes` | unique `channel_id` |
| `lockdowns` | index `(guild_id, type)`, index `(channel_id, type)` |
| `guild_settings` | unique `guild_id` |
| `user_settings` | unique `user_id` |
| `guild_entitlements` | primary key `(guild_id, feature)` |
| `premium_plans` | unique `name` |
| `premium_transactions` | unique `txnid` |
| `alerts` | partial unique on `active` where `active` — only one alert is active at a time |

**Foreign keys.** The source has **zero** ordinary foreign keys, which is why
orphans are everywhere (`Tourney.full_delete` never deletes its media
partners or group lists). Every FK here declares `ON DELETE` explicitly:
`CASCADE` for owned children, `SET NULL` for `premium_transactions.plan_id`.

**`premium_transactions.plan_id` is nullable with `ON DELETE SET NULL`,** and
the plan is **snapshotted** into a `plan_snapshot jsonb` column at purchase
time (name, price, duration_days). Quotient's plan table is destructively
reseeded on every startup, and a `RESTRICT` FK would break that while a
`CASCADE` would destroy paid transactions. The snapshot means the payment page
still renders after a reseed — Quotient's does not, and 500s.

## S6. The nine raw SQL statements become typed queries

The source has nine hand-written SQL statements whose table names are
load-bearing. **All nine are rewritten as Drizzle queries.** That list is the
regression test — each rewritten query gets a test.

| # | Source | What it does | Ours |
|---|---|---|---|
| 1 | `core/Bot.py:208` | `INSERT INTO user_data … ON CONFLICT DO NOTHING` | `insertUserSettings` with `onConflictDoNothing` |
| 2 | `events/tasks.py:22` | `INSERT INTO guild_data … ON CONFLICT DO NOTHING` | `insertGuildSettings` with `onConflictDoNothing` |
| 3 | `premium/__init__.py:157` | reset a user's premium | a typed update |
| 4 | `utility/__init__.py:80` | list a user's reminders via `extra #>> '{args,0}'` | a typed query against `jobs.payload` — **and `jobs` gets a `user_id` column** so it is indexed rather than a JSON path scan |
| 5 | `utility/__init__.py:120` | clear an autorole's roles | a typed update |
| 6 | `utility/functions.py:59` | increment a tag's usage | `UPDATE tags SET usage = usage + 1 …` — keep this one as SQL; it is atomic and Drizzle's update builder would need a raw fragment anyway |
| 7–10 | `utility/functions.py:85-149`, `dev.py:123-235` | six aggregate/window queries over the usage log | typed queries. `SUM(CASE WHEN failed …)` and `COUNT(*) OVER()` translate directly to Drizzle `sql` fragments. **These belong to the dev cog, which does not ship (D41) — so only the two tag-stats queries are ported.** |
| 11 | `scrims.py:558` | `UPDATE sm.scrims SET available_slots = $1` | **gone** — D14 replaces the array with the `slots` table |
| 12 | `scrims.py:633` | the fake-tag overlap check | `slots.members && $2::text[]` — one typed query |
| 13 | `slotm.py:203` | the user's slots across scrims | a typed join over `slots` |
| 14 | `tourney.py:436` | the tourney fake-tag check | **the source query is broken** — it quotes schema-qualified identifiers as single names, so it would raise `relation does not exist`. Rewrite as a typed query. |
| 15 | `slash/scrims.py:467` | the unban lookup | a typed join |
| 16 | `slash/scrims.py:530` | the slot-info lookup | a typed join |
| 17 | `_reminder.py:85`, `:104` | banned-from / already-reminded | typed joins |
| 18 | `slotm/scrimsedit.py:46`, `:69` | mutate `slot_manager.scrim_ids` | **gone** — a `slot_managers` ↔ `scrims` join table replaces the array (S3) |
| 19 | `scrims/_edit.py:37` | `UPDATE sm.scrims SET open_days = $1` | **gone** — `text[]` writes directly through Drizzle |
| 20 | `ssmod/_buttons.py:118` | `UPDATE ss_info SET keywords = $2` | **gone** — `text[]` writes directly |
| 21 | `sockets/schemas/_scrim.py:142` | `UPDATE sm.scrims SET autoclean = $1, open_days = $2` | **gone** — same |

**Nine of the twenty-one disappear entirely** because D14, D25 and D13
replaced the array-plus-join-table pattern with plain columns. The remaining
ones become typed queries.

## S7. The slot table (D14, restated with the final columns)

```sql
slots(
  id uuid primary key default gen_random_uuid(),
  scrim_id uuid not null references scrims(id) on delete cascade,
  num integer not null,
  state text not null check (state in ('free','claimed','locked','banned')),
  team_name text,
  owner_user_id text,
  members text[] not null default '{}',
  message_id text,
  jump_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scrim_id, num)
)
```

**The claim, as one statement:**

```sql
UPDATE slots
   SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 WHERE scrim_id = $1 AND num = $2 AND state = 'free'
RETURNING id;
```

Zero rows returned ⇒ somebody else took it. **The database enforces the
invariant; there is no lock.** This is the single highest-value change in the
port — Quotient protects the same operation with a module-global
`asyncio.Lock` that does not survive a restart or a second process.

**The cancel:**

```sql
UPDATE slots
   SET state = 'free', team_name = null, owner_user_id = null, members = '{}'
 WHERE id = $1 AND owner_user_id = $2;
```

**How many are free:** `SELECT count(*) FROM slots WHERE scrim_id = $1 AND state = 'free'`.
No array, no join table, no read-modify-write.

## S8. Arrays that stay arrays

Postgres arrays are kept where the code genuinely needs set semantics on a
list of ids with no natural key:

- `slots.members` — the fake-tag check is an array overlap (`&&`).
- `tourney_slots.members` — same.
- `autorole_configs.humans` / `.bots` — role id lists.
- `tourneys.banned_users` — **changed to a `tourney_banned_users` join
  table.** `ARRAY_APPEND`/`ARRAY_REMOVE` are read-modify-write and will race
  under concurrent bans; a join table with a unique constraint is idempotent.
- `lockdowns.channel_ids` — a list of channel ids locked by one action.
- `ss_configs.keywords` — a list of keywords to match in OCR text.
- `scrims.open_days`, `scrims.autoclean` — enum arrays with containment checks.

**`slot_managers.scrim_ids` becomes a join table.** It has two independent
writers, a raw-SQL array concatenation, and a `FULL OUTER JOIN` in the source's
own query. All three are reasons to stop treating it as an array.

## S9. Timestamps

- Every timestamp column is `timestamptz`. The database stores instants.
- `Asia/Kolkata` is a **default**, not a hard-coding. A bot-level
  `DEFAULT_TIMEZONE` constant, with an optional per-guild override column on
  `guild_settings`. The target's logger already uses IST, so IST is the
  default that matches existing behaviour.
- All parsing goes through one `parseNaturalTime(input, { now, timeZone })`.
  Quotient has six call sites with three different setting sets.
- The "past ⇒ roll forward 24 hours" rule is preserved where the source
  applies it. It is load-bearing for "today at 4pm" typed after 4pm IST.

## S10. `command_usage` needs a retention policy

The source has none, and writes one row per command invocation. **A daily
prune job deletes rows older than 30 days.** The table also gets composite
indexes `(guild_id, cmd)` and `(user_id, cmd)` because the two tag-stats
queries that ship filter on exactly those.

## S11. Not ported

| Source | Reason |
|---|---|
| `ptable_tourney`, `ptable_teams`, `ptable_match` | orphaned module — never registered with Tortoise, so the tables never existed. Two of the three models are internally broken. |
| `subscriptions`, `subscription_plans`, `subscription_logs` | orphaned module; `SubLog` is truncated to one field |
| `Scrim.autoclean_done` | never read or written |
| `Scrim.show_time_elapsed` | only read by the dashboard schema, which does not ship. **If someone wants the "time elapsed" footer to be conditional, that is a new feature request, not a port.** |
| `Scrim.banlog_channel_id` | `ban_logs` has its own `channel_id`; the scrim column is never read |
| `Guild.tag_enabled_for_everyone` | never read |
| `Guild.premium_notified`, `Guild.public_profile` | never read |
| `User.premium_notified`, `User.public_profile` | never read |
| `User.made_premium` | write-only garbage (S4) |
| `Votes.public_profile` | never read; the leaderboard it implies does not exist |
| `Alert.conditions` | never read or written |
| `LockType.category` | never used |

## S12. Type differences worth knowing

| Source | Ours | Why |
|---|---|---|
| `BIGINT` snowflake | `text` | S2 |
| `BIGSERIAL` pk | `uuid` | S1 |
| `BIGINT[]` snowflake array | `text[]` | S2 |
| `BIGINT` scrim id in `scrim_ids[]` | `uuid[]` → join table | S1, S8 |
| `BIGINT` µs (`TimeDeltaField`) | `integer` days | Postgres `INTERVAL` has no lossless JS mapping. `premium_plans.duration_days integer not null`. **Not** `interval` — the extra column was belt-and-braces and days is what the app computes with. |
| `VARCHAR(1024)` for a 16-char hash | `text` | the source over-provisioned; the value is 16 hex chars |
| `VARCHAR(n)` everywhere | `text`, except `guild_settings.prefix` which keeps a `CHECK (char_length(prefix) <= 5)` | the source's `max_length` was a Tortoise-side validator, not a domain rule. The prefix length *is* semantic — the source checks it explicitly. |
| `INT4` tourney id on `media_partners` | `uuid` | the source has an INT4/INT8 mismatch — a latent overflow that uuid makes impossible |
| `INT` pk on `media_partners.channel_id` | surrogate `id` + unique `channel_id` | same pattern for `tourney_group_lists.message_id` |

## S14. Verified against the live database

The schema is built, migrated and applied to the running Postgres. Verified
on the live database, not asserted in prose:

**35 tables.** 30 unique constraints, 14 check constraints, 15 foreign keys.
All five renamed tables present (`autorole_configs`, `autopurge_configs`,
`blocklist`, `media_partner_slots`, `user_settings`).

`slots` carries `uuid` PK, `text[]` members, `timestamptz` timestamps,
`UNIQUE (scrim_id, num)`, the state `CHECK`, and one the spec did not ask for
and that should stay:

```sql
CHECK (state <> 'claimed' OR owner_user_id IS NOT NULL)
```

A claimed slot must have an owner. The source had no such rule and could
leave a claimed slot with nobody attached to it.

**The claim race, run against the live database:**

```
--- two claims, same slot, one transaction ---
UPDATE ... WHERE scrim_id=$1 AND num=1 AND state='free'  -- userA
  result  | userA won
  UPDATE 1
UPDATE ... WHERE scrim_id=$1 AND num=1 AND state='free'  -- userB
  (0 rows)
  UPDATE 0
--- final state ---
 num |  state  | owner_user_id | team_name
-----+---------+---------------+-----------
   1 | claimed | userA         | Team A
```

One row updated, one rejected, one owner. Under the source's design — a
free-slot array on the scrim plus a row per claimed slot — the same sequence
produces **two rows claiming slot 1**. The database now enforces the
invariant; there is no lock to get wrong.

**Three places the spec and the source pulled in different directions**, and
how they were resolved:

1. **`guild_entitlements` has no `id`.** §S4 says every table has one; §S5
   says its primary key is `(guild_id, feature)`. Both cannot hold. The
   specific rule wins: the table has `created_at` and `updated_at` but no
   `id`, and the composite primary key *is* the invariant. The pair is the
   key; an `id` would be a second, redundant identity.
2. **The `open_days` containment `CHECK` does not forbid duplicates.**
   `open_days <@ ARRAY['monday',...]::text[]` rejects an unknown weekday but
   accepts `['monday','monday']`. Postgres has no "distinct elements" array
   constraint. The set semantics come from the read side — as they did in
   the source.
3. **`duration_days` and the lifetime plan.** Quotient's lifetime plan is
   25,185 days, not literally forever. That number was preserved exactly
   rather than replaced with a "forever" sentinel, because the payment
   provider wants a finite period.

**Four things the schema cannot express cleanly**, all accepted
deliberately:

- **The one-active-alert rule is a partial unique *index*, not a
  constraint.** `CREATE UNIQUE INDEX alerts_active_unique ON alerts (active)
  WHERE active`. Postgres has no partial constraint, only partial indexes.
  This is the only correct translation, but an audit that counts
  `pg_constraint` rows will not see it.
- **`uuid v4` is the Postgres default's promise, not a schema guarantee.**
  `gen_random_uuid()` is v4 in Postgres 16 and needs no extension, but the
  version is not visible in the schema — `pg_typeof` cannot distinguish v4
  from v7. If v7 ever becomes the default, ids change shape silently.
- **`plan_snapshot` is `jsonb`, so its shape is not database-enforced.** The
  `{name, price, duration_days}` shape lives in a TS interface. A malformed
  snapshot written by raw SQL would not be caught. Same tradeoff as every
  other enum here: the union lives in TypeScript, the constraint in SQL, and
  the two are kept in sync by hand.
- **`jobs.event` is a `CHECK`, not a foreign key to a dispatch table.** An
  event name that no handler implements satisfies the check and would sit in
  the table forever. A lookup table with an FK would put the handler registry
  in the database — and the handler registry is code.

**`command_usage` retention** is `db/retention.ts` — `pruneCommandUsage()`,
called by the scheduler daily. The 30-day policy is S10.

**The plan seed upserts, it does not reseed.** Quotient's `insert_plans()`
deleted every row on each startup, which would destroy the paid transactions
pointing at a plan. `seedPremiumPlans()` upserts on a natural key (`code`);
a plan removed from the catalogue is left alone, and the receipt reads
`plan_snapshot` regardless.

## S15. Open items — decided

| # | Question | Decision |
|---|---|---|
| 1 | uuid or bigserial pk? | **uuid v4**, `command_usage` excepted (S1) |
| 2 | `ptable.py` / `reserve.py` in scope? | **No** (S11) |
| 3 | Dead columns in scope? | **No** (S11) |
| 4 | Rename `stoggle` → `enabled`? | **Yes** (S4) |
| 5 | `duration` as interval or days? | **days** (S12) |
| 6 | `slot_managers.scrim_ids` array or join table? | **Join table** (S8) |
| 7 | What is `User.made_premium`? | **Dropped** (S4) |
| 8 | Is `show_time_elapsed` a half-finished feature? | **Dropped** (S11). If it is wanted, it is a new request. |
| 9 | Timestamp rendering timezone? | **IST by default, per-guild override** (S9) |
| 10 | `command_usage` retention? | **30 days, daily prune** (S10) |
