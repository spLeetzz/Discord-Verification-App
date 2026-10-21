# The community area on SQLite

The database layer moved from Postgres to SQLite underneath this area.
Everything below is what changed in `modules/community/` and
`commands/community/`.

---

## 1. The join table

`autorole_configs.humans` and `.bots` were `text[]` columns. They are
now rows in `autorole_roles`:

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | the uuid, generated in the app |
| `guild_id` | `text` | foreign key to `autorole_configs.guild_id`, `ON DELETE CASCADE` |
| `kind` | `text` | `human` or `bot`, `CHECK`ed |
| `role_id` | `text` | the Discord role id |
| `created_at` / `updated_at` | `integer` | epoch milliseconds |

`UNIQUE (guild_id, kind, role_id)` is the constraint the toggle leans on,
and `autorole_configs` keeps `UNIQUE (guild_id)` and nothing else — it is
now only the marker that says "this guild has auto-roles".

The area still speaks in two lists. `AutoroleConfig` still has `humans`
and `bots`, `AutoroleKind` is still `"humans" | "bots"`, and
`/autorole humans` and `/autorole bots` are still the subcommand names.
`repo.ts` folds the join table's `kind` into those lists at the boundary
and nowhere else, so `commands/autorole.ts`, `listeners.ts` and
`views/embeds.ts` did not change.

---

## 2. How the toggle stays atomic

The old statement was one `INSERT … ON CONFLICT … DO UPDATE` that chose
`array_append` or `array_remove` in the database. A join table cannot do
that in one statement — SQLite has no data-modifying CTEs — but it can do
it in two **atomic** statements with no read in between:

```ts
// 1. the parent row, if the guild has none yet
await db.insert(autoroleConfigs).values({ guildId })
  .onConflictDoNothing({ target: autoroleConfigs.guildId });

// 2. the toggle itself: the unique constraint answers the question
const inserted = await db.insert(autoroleRoles)
  .values({ guildId, kind, roleId })
  .onConflictDoNothing()
  .returning({ id: autoroleRoles.id });

// 3. the role was already there, so it comes out
if (inserted.length === 0) {
  await db.delete(autoroleRoles).where(/* guild, kind, role */);
}
```

The insert **is** the read. If it returns a row the role was not there and
is now added; if it returns nothing the role was already there and comes
out. Nothing in the decision is a read-then-write, so there is no window
in which two moderators clicking at once can lose a role.

The `added` flag the command replies with used to come from a separate
`findAutoroleConfig` call *before* the toggle — a stale read that could
say "added" about a role another moderator had just removed. It now comes
from the insert's own outcome, so the reply is as atomic as the write.

`removeAutoroleRole` is a single `DELETE`; `clearAutoroleRoles` is a
single `DELETE` of the guild's role rows (the config row stays, as
before).

---

## 3. Everything else that changed

| What | Before | After |
|---|---|---|
| Tag search | `name ILIKE '%q%'` | `lower(name) LIKE lower('%q%')` |
| Usage counter | raw `UPDATE … usage = usage + 1, updated_at = now()` | builder statement: `.set({ usage: sql\`usage + 1\`, updatedAt: new Date() })` — still one statement, and the `Date` is encoded the way the column stores it on each engine |
| Counts | `count(*)::int` (8 places) | `cast(count(*) as integer)` — `::` is Postgres syntax and SQLite rejects it |
| Unique violation | Postgres SQLSTATE `23505` only | also `SQLITE_CONSTRAINT_UNIQUE`, found by walking the wrapped error chain |

**Nothing in the area was left speaking one engine.** No `ILIKE`, no
`now()`, no `::`, no `ARRAY[…]::text[]`, no `= ANY(…)`, no `array_append`.

The id, timestamp, boolean and JSON columns needed no change: the dialect
helpers handle them, and the area still reads `Date`s, `boolean`s and
parsed objects.

---

## 4. What did not fit

Two things, both small:

1. **The kind vocabulary.** The schema says `human` and `bot`; the area
   says `humans` and `bots` because those are the subcommand names. The
   mapping is one object in `repo.ts`, typed with `satisfies` so a kind
   the schema does not have is a compile error.
2. **`autorole_roles.guild_id` points at `autorole_configs.guild_id`, not
   at `autorole_configs.id`.** So a role row cannot exist without the
   config row, and the toggle has to create the config row first. That is
   the `ON CONFLICT DO NOTHING` insert at the top of the toggle — one
   extra statement, atomic on its own.

Nothing else in the schema was missing. `tags` still is keyed by
`(guild_id, name)` with `owner_id` and `usage`, and the unique constraint
is still the case-insensitive one, because the name is still stored
lower-cased.

---

## 5. Tests

`npm test` is green for the area: **9 files, 120 tests**.

New in `repo.test.ts`:

- the toggle adds, removes, keeps the two lists apart, and never holds a
  role twice;
- **two concurrent toggles lose no role**, and neither does a crowd of
  eight;
- the same toggle racing itself holds the role at most once, and exactly
  one of the two reports "added";
- the tag search finds `Foo`, `foo` and `FOO`, and finds every spelling
  when more than one is stored;
- **the usage counter survives twenty concurrent increments** — all
  twenty counted;
- a unique violation is recognised as one.

The two atomic statements are proved by breaking them: turning the usage
counter into a read-modify-write loses nineteen of twenty counts, and
turning the toggle into one loses the role it was adding.

---

## 6. One thing the manager has to do

`6160eea` ("Swap the Postgres driver for libsql") swept up this area's
work, including the unique-violation test — but **not** the last fix to
`isUniqueViolation`. The committed code looks for `SQLITE_CONSTRAINT_UNIQUE`
one link too high in the wrapped error chain, so the new test fails
against it. The fix is in the working tree, in
`modules/community/repo.ts` only, and needs committing.
