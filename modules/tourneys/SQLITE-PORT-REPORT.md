# The tournaments area, on SQLite

What changed in `modules/tourneys/` and `commands/esports/` when the
database moved from Postgres to SQLite. The short version: the member
list is a table now, the fake-tag check is a join, and the row lock is a
write.

---

## The new join table

`tourney_slots.members` was a `text[]`. It is `tourney_slot_members`
now:

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | primary key, uuid generated in the app |
| `tourney_slot_id` | `text` | → `tourney_slots.id`, `ON DELETE CASCADE` |
| `user_id` | `text` | the Discord id |
| `created_at` | `integer` | epoch milliseconds |
| `updated_at` | `integer` | epoch milliseconds |

`UNIQUE (tourney_slot_id, user_id)` and an index on `user_id`.

`media_partner_slots.members` moved the same way, to
`media_partner_slot_members` — same shape, one `media_partner_slot_id`
instead of `tourney_slot_id`. That one was not on the brief, but it broke
in the same way, so it is fixed too.

**The domain type did not change.** `TourneySlotRecord.members` is
still `readonly string[]`, and so is `MediaPartnerSlotRecord.members`.
The list is read from the table and handed to the record; nothing above
`repo.ts` learned that the join exists.

### The slot write

`repo.insertSlot` writes the slot row and the member rows in **one
transaction**:

```sql
insert into "tourney_slot_members" ("id", "tourney_slot_id", "user_id", "created_at", "updated_at")
values (?, ?, ?, ?, ?) on conflict do nothing
```

One row per member, one statement, the unique key making a repeated
member a no-op. **The leader is always one of them** — the set written
is `[leaderId, ...members]`, deduped. The old array already contained
the leader (the registration's member list started with the author),
but the member *table* is what the fake-tag check reads, so the leader
has to be in it.

### The slot read

`repo.toSlots` reads the member table **once for the whole set** of
slots and hands each row its list — a query per slot would be a
round-trip per row.

The order is `(created_at, user_id)`. The old array preserved
insertion order (leader first); the join table has no position column,
so the order is deterministic but not "leader first". Nothing depends
on it — the export CSV's teammate column is the only place it shows.

---

## The fake-tag check

It was a Postgres array overlap in raw SQL:

```sql
tourney_slots.members && ARRAY[$1, $2]::text[]
```

It is a **join** now (`repo.findFakeTagMatches`):

```sql
select distinct "tourney_slots"."id", "tourney_slots"."tourney_id", ...
  from "tourney_slots"
  inner join "tourney_slot_members"
    on "tourney_slot_members"."tourney_slot_id" = "tourney_slots"."id"
 where ("tourney_slots"."tourney_id" = ?
   and "tourney_slot_members"."user_id" in (?, ?)
   and "tourney_slots"."id" <> ?)
 order by "tourney_slots"."num" asc
```

The same question, answered by the index on `user_id` instead of by
scanning an array.

- **`DISTINCT` matters.** A slot that holds *two* of the mentioned
  users matches twice, and the answer is a set of slots, not a set of
  matches. The source's `&&` returned the slot once.
- **The slot being checked can be left out.** The third argument,
  `exceptSlotId`, adds `tourney_slots.id <> ?`. The registration path
  has no slot yet, so it does not use it — but the check answers
  "another slot", and the exclusion is part of that.

`repo.listSlotsOfUser` — "the slot a user leads, or is a member of" —
had the same array overlap. Its membership half is a correlated
`EXISTS` now:

```sql
select ... from "tourney_slots"
 where ("tourney_slots"."tourney_id" = ?
   and ("tourney_slots"."leader_id" = ?
     or exists (select 1 from "tourney_slot_members"
                 where ("tourney_slot_members"."tourney_slot_id" = "tourney_slots"."id"
                   and "tourney_slot_members"."user_id" = ?))))
 order by "tourney_slots"."num" asc
```

---

## The row lock

`repo.nextSlotNumberIn` did:

```sql
select id from "tourneys" where id = ? for update
```

which is a **syntax error in SQLite** — there is no `FOR UPDATE`. It is
a conditional `UPDATE` now:

```sql
update "tourneys" set "updated_at" = ? where "tourneys"."id" = ? returning "id"
```

A write takes the lock for the rest of the transaction, and the update
is *conditional*: zero rows means the tournament was deleted underneath
us, and the number would be meaningless.

On top of that, `insertSlot` and `nextSlotNumber` run behind a
**per-tourney mutex** (`repo.withTourneyLock`, a promise chain keyed by
the tournament id). The write lock only lasts for the length of its own
transaction, so two transactions in the same process would still race
for the number; the mutex closes that gap. It is per tournament, not
global — two registrations for different tournaments do not wait for
each other.

`nextSlotNumber` lost its `tx` parameter: it bypassed the mutex and
would have deadlocked if it were called from the locked path. Nothing
outside `repo.ts` used it.

---

## What else changed, and what did not

### Changed

- **`TourneyEmojis` and `MessageDeleteJobPayload` are type aliases now,
  not interfaces.** The JSON column is typed `Record<string, unknown>`,
  and an interface has no implicit index signature — so they stopped
  type-checking as JSON values. No runtime change.
- **The tests assert the constraint, not the engine's name.**
  `repo.test.ts` and `jobs.test.ts` expected the Postgres SQLSTATE
  `"23505"` / `"23514"`; SQLite reports `SQLITE_CONSTRAINT_UNIQUE` /
  `SQLITE_CONSTRAINT_CHECK`. A `constraintKind` helper reads either, so
  the assertion says what was violated.
- **`count(*)::int` → `count(*)`** in `slots.test.ts` — a Postgres cast.
- **The stale rows in `README.md` and `PORT-REPORT.md`** that described
  the array overlap and the `FOR UPDATE` lock were corrected.

### Not changed

- **The swap** is still one transaction, three statements, through the
  temporary number `-1`, respecting `UNIQUE (tourney_id, num)`.
- **The status enum** is still `draft | open | paused | closed`.
- **The group algorithm** is still a flat chunk of the ordered slot
  list by `group_size`.
- **The daily open** is still a row in the durable `jobs` table, and
  the schedule is still derived from the stored schedule.
- **The `idp` command** — its `msg_delete` job, its ephemeral reply,
  its refusal to log the password — is untouched.
- **The `tourneys:select:pick` fix** and the
  `tourneys:slotm_pick:<tourneyId>:<userId>` custom id are untouched.
- **`tourney_banned_users`** already was a join table and its shape
  still matches what the area uses. No change was needed.

### Nothing to do

- **`now()`** — the area had none in raw SQL. Every timestamp it writes
  is an app-computed parameter (`new Date()`).
- **`ILIKE`** — the area had none.

---

## Tests

`modules/tourneys/` — 9 files, 108 tests, all green.

New:

- the fake-tag check reports a slot **once** even when it holds two of
  the mentioned users;
- the fake-tag check **leaves the slot being checked out** of the
  answer;
- a registration **records the leader and the mentioned teammates**, and
  the list is there when the slot is read again.

---

## For the database engineer

Nothing in `db/` was needed to make this area work, and nothing in
`db/` was worked around. Two notes:

- `jobs.payload ->> 'tourneyId'` was left as it is. SQLite has had the
  `->>` JSON operator since 3.38 and the payload is a JSON text, so the
  same expression works on both engines — no change needed.
- `db/README.md` still describes the Postgres layer (`text[]` arrays,
  `bigserial`, `timestamptz`, the migration workflow). It reads as if
  the port to SQLite never happened.
