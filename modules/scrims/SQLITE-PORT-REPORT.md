# The scrims area, on SQLite

What changed in `modules/scrims/` and `commands/esports/scrims.ts` when
the database moved from Postgres to SQLite. The short version: every
list of ids is a table now, the fake-tag check is a join, and the claim
is still one conditional `UPDATE`.

---

## The new join tables

`slots.members` was a `text[]` of the user ids in a slot. It is
`slot_members` now:

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | primary key, uuid generated in the app |
| `slot_id` | `text` | → `slots.id`, `ON DELETE CASCADE` |
| `user_id` | `text` | the Discord id |
| `created_at` | `integer` | epoch milliseconds |
| `updated_at` | `integer` | epoch milliseconds |

`UNIQUE (slot_id, user_id)` and an index on `user_id`.

Two more lists in this area were arrays too, and moved the same way:

| Was | Now | Shape |
|---|---|---|
| `reserved_slots.members` | `reserved_slot_members` | `reserved_slot_id` → `reserved_slots.id` |
| `banned_teams.members` | `banned_team_members` | `banned_team_id` → `banned_teams.id` |

Both have `UNIQUE (parent_id, user_id)` and `ON DELETE CASCADE`, so a
reservation or a ban that is deleted takes its team with it.

**The domain type did not change.** `SlotRecord.members`,
`ReservedSlotRecord.members` and `BannedTeamRecord.members` are still
`readonly string[]`. The list is read out of the table and handed to the
record; nothing above `repo.ts` learned that the join exists. The
views, the panels, the renders and the service are untouched.

### The read

The members of a set of slots are read **once for the whole set** and
handed to each row — a query per slot would be a round trip per row.

The order is the order the rows were written in, and the captain is put
first explicitly (`orderMembers`): the join table has no position
column, so the order of two members written in the same statement is
not defined, and the source's array always had the captain first.

### The write

The claim, the release, the state change and the team change all write
the member rows **in the same transaction as the slot row**:

```sql
delete from "slot_members" where "slot_members"."slot_id" = ?
insert into "slot_members" ("id", "slot_id", "user_id", "created_at", "updated_at")
values (?, ?, ?, ?, ?)
```

One row per member, the unique key making a repeated member a no-op.
The list is **replaced**, never merged: the team that was on the slot is
the team that is off it. That is the "Change Team" button, and it is
the same write the ID-Pass transfer does in the slot area.

---

## The fake-tag check

It was a Postgres array overlap in raw SQL:

```sql
slots.members && ARRAY[$1, $2]::text[]
```

It is a **join** now (`repo.findFakeTagMatches`):

```sql
select distinct "slots"."id", "slots"."scrim_id", ...
  from "slots"
  inner join "slot_members" on "slot_members"."slot_id" = "slots"."id"
 where ("slots"."scrim_id" = ?
   and "slots"."state" = 'claimed'
   and "slot_members"."user_id" in (?, ?)
   and "slots"."id" <> ?)
```

The same question, answered by the index on `user_id` instead of by
scanning an array — and now correct on both engines, because there is no
array operator left to get wrong.

- **`DISTINCT` matters.** A slot that holds *two* of the mentioned
  users matches twice, and the answer is a set of slots, not a set of
  matches. The source's `&&` returned the slot once.
- **The slot being checked can be left out.** The third argument,
  `excludeSlotId`, adds `slots.id <> ?`. The registration path has no
  slot yet, so it does not use it — but the check answers "another
  slot", and the exclusion is part of that.

---

## The claim

Unchanged, and that is the point:

```sql
update "slots"
   set "state" = 'claimed', "team_name" = ?, "owner_user_id" = ?,
       "message_id" = ?, "jump_url" = ?, "updated_at" = ?
 where "scrim_id" = ? and "num" = ? and "state" = 'free'
 returning "slots"."id", ...
```

One conditional `UPDATE`. Zero rows returned means somebody else won.
**No lock and no read-then-write** — the source protected the claim
with a module-global `asyncio.Lock` that died with the process, so two
users could own one slot.

What changed is only that the team is no longer a column of the same
statement. The claim wins the slot, and **then** the member rows are
written, in the same transaction. The atomicity of the claim comes from
the `UPDATE`; the member rows ride along in the transaction that the
`UPDATE` opened.

`repo.claimSlot` returns `null` when the update matched nothing, and
the service re-reads the slot and tries the next free number — exactly
as before.

---

## The open days and the autoclean kinds

Both were arrays on the `scrims` row. Both are join tables now:

| Was | Now | Shape |
|---|---|---|
| `scrims.open_days` | `scrim_open_days` | `(scrim_id, day)`, `UNIQUE (scrim_id, day)` |
| `scrims.autoclean` | `scrim_autoclean` | `(scrim_id, kind)`, `UNIQUE (scrim_id, kind)` |

**The containment check is on the join table**, not on the write path:

```sql
CONSTRAINT "scrim_open_days_day_check"
  CHECK("scrim_open_days"."day" in ('monday', 'tuesday', …))
CONSTRAINT "scrim_autoclean_kind_check"
  CHECK("scrim_autoclean"."kind" in ('channel', 'role'))
```

So the database refuses a day that is not a weekday and a kind that is
not `channel` or `role`. The write path only replaces the rows.

> **Note for the manager — a difference from the brief.** The brief said
> `autoclean` would become two boolean columns, `autoclean_channel` and
> `autoclean_role`. The committed schema has `scrim_autoclean` as a
> **join table** with a `kind` column, and the `scrims` row has no
> boolean columns for it. I wrote against the committed schema, because
> it is what exists and what the generated migration contains. The
> domain type (`ScrimRecord.autoclean: AutocleanKind[]`) is unchanged
> either way, so if the schema does move to two booleans, only
> `repo.replaceAutoclean` and `repo.loadScrimExtras` change — nothing
> above `repo.ts` does.

The domain types still say "a list of days" and "a list of kinds":

```ts
readonly openDays: Weekday[];
readonly autoclean: AutocleanKind[];
```

### The write path

`repo.updateScrim` takes the two lists **with** the columns and writes
them in the same transaction:

```ts
export interface ScrimUpdate extends ScrimColumnUpdate {
  readonly openDays?: readonly Weekday[];
  readonly autoclean?: readonly AutocleanKind[];
}
```

So the editor's "which days" button and the autoclean panel still call
`repo.updateScrim(scrim.id, { openDays })` — they do not know the
lists are tables. `updateAllScrims` ("apply to all scrims") does the
same for every scrim of the guild.

---

## What else changed, and what did not

### Changed

- **`ScrimEmojis` and `EmbedTemplate` are type aliases now, not
  interfaces.** The JSON columns are typed `Record<string, unknown>`,
  and an interface has no implicit index signature — so they stopped
  type-checking as JSON values. No runtime change.
- **The autoclean button's `kind` is typed.** `const kind: AutocleanKind
  = …` — a conditional expression widens its literal branches to
  `string`, and the widened value no longer fitted the closed union.
- **The area's writes are behind an in-process mutex.** SQLite has one
  writer: two transactions that overlap cannot both hold the write
  lock, and the second one fails with `SQLITE_BUSY` rather than
  waiting. The mutex (`withLock`, `utils/lock.ts`) makes the second one
  wait, so a claim that loses the race loses it *cleanly* — the
  conditional `UPDATE` updates zero rows and the service tries the next
  free slot — instead of throwing. **The mutex is not what makes the
  claim exclusive**; the `UPDATE` is. Take the mutex away and the claim
  is still correct.
- **The stale rows in `README.md`** that described the array overlap and
  the array column of the claim were corrected.

### Not changed

- **The slot state machine** is still `free ⇄ claimed`, plus `locked`
  and `banned` for moderators.
- **The requirements matrix**, the ban-type matrix, the reserved-slot
  flow, the autoclean behaviour (channel purge and role strip) and the
  templates are all as they were.
- **`slotlist_format` / `open_message` / `close_message`** are still
  JSON documents, now held as text with a typed `$type<>`.
- **The durable jobs** are still rows in the `jobs` table. The payload
  is read with `->>`, which is portable: a `jsonb` on Postgres, the
  JSON text on SQLite (3.38 and later — the build here is 3.45.1, and
  `repo.test.ts` proves it).

### Nothing to do

- **`now()`** — the area had none in raw SQL. Every timestamp it writes
  is an app-computed parameter (`new Date()`).
- **`ILIKE`** — the area had none.
- **`SELECT … FOR UPDATE`** — the area had none.

---

## Tests

`modules/scrims/` — 13 files, 151 tests, all green. New file:
`modules/scrims/repo.test.ts`, which writes to the live database.

- the claim gives the slot to one claimant and to nobody else — the
  second claim updates zero rows and the slot still belongs to the
  first claimant;
- exactly one of two simultaneous claims wins;
- a claim records every mentioned teammate, and the rows are the
  member rows of the join table;
- a claim that loses the race writes **no** member row;
- the team is replaced, not merged, when the team changes;
- a released slot has no members;
- the fake-tag check finds a player who is already on another slot, does
  not fire for a player who is on no slot, does not fire for a slot that
  is not claimed, leaves the slot being checked out of the answer, and
  does not look at another scrim;
- the open days and the autoclean kinds round-trip, and are replaced
  when the scrim is edited;
- a reservation keeps its team;
- the durable job of one scrim is found, is not confused with another
  scrim's, and is replaced rather than stacked.

---

## For the manager and the database engineer

- **The ID-Pass transfer is not in this area.** It lives in
  `modules/slots/repo.ts` (`transferSlot`), which is the slot area's
  file; that area is already on the join table, and its own test covers
  the transfer. The equivalent write in this area is
  `repo.changeSlotTeam` — "Change Team" — which is tested here.
- **The process-wide write mutex belongs in `db/client.ts`.** SQLite has
  one writer for the whole database, so a scrims write and a tourneys
  write can still collide on the write lock, and the loser gets
  `SQLITE_BUSY`. The mutex in this area covers this area only. Taking
  the lock inside `withTransaction` — one place, every area — would
  close that for the whole bot.
- **`db/README.md` and `db/schema.test.ts`** were stale when this area
  was ported (they described the Postgres layer and the `members`
  array). They have since been updated by the database engineer, so
  nothing is outstanding there.
- **`data/` is now in `.gitignore`** — the SQLite file must not be
  committed.
