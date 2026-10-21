# `db/` — the write queue: report

The hazard the moderation engineer found is a `db/` problem, and it is
fixed here: **one queue, in front of every write in the process.**

Nothing outside `db/` changed. `db`, `withTransaction`, `closeDatabase`
and every query the eight modules call keep their exact signatures, and
no module had to be touched.

---

## 1. The shape, and where it sits

`db/write-queue.ts` (new) holds the queue. `db/client.ts` wires it in.

**It wraps the libsql client**, so it is in front of *every* statement
the application runs — the query builders, the raw `db.execute(sql…)`
statements, the boot migrations, the seed, the retention prune and the
scheduler's deletes. That is the whole point: a write that bypasses the
queue can still collide, so the queue is not "in front of the module
writes" but "in front of the connection".

```
module code  →  db (drizzle)  →  QueuedClient  →  libsql client  →  file
                                    ↑
                             the write queue
```

| | |
|---|---|
| **What is queued** | The writes. A statement is a write unless its first keyword is `select`, `pragma`, `explain` or `values`; `with` is deliberately a write, because SQLite allows a data-modifying statement after it. |
| **What is not queued** | The reads. A read must not wait behind a long write, or the whole bot stalls behind one slow transaction. |
| **The transaction is the unit** | A transaction holds the write lock for its whole body, so it holds the queue for its whole body too: the slot is taken when the transaction is opened and given back when it is committed or rolled back. |
| **The queue does not decide races** | The unique constraints are still the authority. The queue only makes two statements *reach* the database one after the other, so the loser gets the constraint's error rather than the driver's. |

**The busy timeout stays** — and it was fixed on the way. `PRAGMA
busy_timeout = 5000` reached *one* connection of the pool; the driver
applies the `timeout` option to **every** connection it opens, so the
client is now opened with `timeout: BUSY_TIMEOUT_MS` and the pragma
stays as the belt. The timeout is what covers another *process* writing
the same file; the queue is what covers this one.

---

## 2. Re-entrancy, and the transaction case

**A transaction's body must not go back through the queue**, or the
transaction waits for itself: it is holding the queue while it runs.

Two mechanisms, both in `db/write-queue.ts`:

1. **The transaction is the unit.** The statements a transaction runs
   through its own handle go to the transaction's connection, never
   through the queue. The queue slot is held from the open to the
   commit.

2. **The transaction context.** A transaction's body calls repository
   functions that themselves write, and those functions may write
   through the *database* handle rather than the transaction handle.
   An `AsyncLocalStorage` carries the open transaction through the async
   call chain (`db/write-queue.ts`, `transactionContext`), so a write
   issued anywhere inside the body is executed **on the transaction's
   connection** — it joins the transaction, and it is rolled back with
   it if the transaction fails.

   It is an `AsyncLocalStorage` and not a variable because a
   transaction and the rest of the bot run at the same time: a write
   from *outside* the body must not be dragged into somebody else's
   transaction. It is queued like any other write.

The context is set by wrapping `db.transaction` (drizzle's method, same
signature) in `db/client.ts` — so it covers `withTransaction` and the
one direct `db.transaction(…)` call in `modules/slots/repo.ts` alike.

**A transaction inside a transaction** cannot take the queue (the outer
one is holding it), so it becomes a **savepoint** on the same
connection: the statements run there, and a rollback undoes only what
the nested block wrote.

---

## 3. Why the queue, and not the alternatives

The brief offered a single shared connection or a read/write split.
**The queue**, for three reasons:

- **A single connection is worse, not better.** SQLite gives a
  transaction its own connection *by design*; forcing every write onto
  one connection would make a second `BEGIN` an error ("cannot start a
  transaction within a transaction"), and an unrelated write would be
  committed or rolled back with somebody else's transaction.
- **A read/write split does not help here.** The contention is not
  between reads and writes — it is between two *writers*, one of which
  is a transaction that holds the write lock for its whole body. A
  dedicated writer connection would still be one connection, with the
  same problem.
- **Serialising writes is not "blunt" — it is what SQLite already
  does.** SQLite has one writer. A write that arrives while a
  transaction is open *cannot* proceed; today it fails with
  `SQLITE_BUSY`, and with the queue it waits its turn. The queue does
  not add a restriction SQLite did not already have; it replaces a
  driver error with the database's own answer.

The one real cost: a transaction blocks the other writes for its whole
duration, including the part of it that only reads. That is inherent to
a single-writer engine — a concurrent write would have failed rather
than succeeded — and the transactions here are milliseconds long.

---

## 4. The two `FOR UPDATE` sites

**Both are already gone in the working tree. No dispatch is needed.**

| Site | State |
|---|---|
| `modules/tourneys/repo.ts` | The `select id from "tourneys" where id = ? for update` is gone. It is a conditional `UPDATE` (`update "tourneys" set "updated_at" = ? where id = ? returning id`) — see `nextSlotNumberIn` and `modules/tourneys/SQLITE-PORT-REPORT.md`, "The row lock". |
| `modules/premium/repo.ts` | Both `.for("update")` calls are gone. `lockGuildSettings` and `markTransactionPaid` are conditional `UPDATE`s now. |

The evidence, over the whole tree:

```
$ grep -rn "\.for(" --include="*.ts" .            # → no matches
$ grep -rn -i "for update" --include="*.ts" .     # → comments and docs only
```

The only remaining mentions are the comments that *explain* the
replacement (`"SQLite has no SELECT … FOR UPDATE"`) and the porting
reports. The moderation engineer's report was accurate about the shape
of the hazard, but both sites had already been fixed — the tourneys one
in commit `6160eea`, the premium one in the working tree.

---

## 5. The tests

`db/write-queue.test.ts` (new, 7 tests). It opens a temporary SQLite
file, applies the migration, and asserts against a real database.

| Test | What it proves |
|---|---|
| "answers a contended write with the constraint, not with SQLITE_BUSY" | Two overlapping writes: the loser gets `SQLITE_CONSTRAINT_UNIQUE`, **not** `SQLITE_BUSY`. |
| "makes a write outside a transaction wait for the transaction" | A `DELETE`-shaped write issued while a transaction is open waits for its turn instead of colliding. |
| "lets a transaction body write through the database handle" | The re-entrancy case: a write issued inside a transaction body through the *database* handle joins the transaction instead of deadlocking against it. |
| "rolls the inner write back with the transaction that made it" | That inner write is part of the transaction — it is rolled back with it. |
| "lets a transaction inside a transaction join it" | The nested case: a savepoint on the same connection, no deadlock. |
| "lets the constraint decide the race, not the driver" | The double-lock race: one caller is told "claimed", the other "already locked" — the constraint's answer, not a busy error. |
| "does not make a read wait for a write" | A read during an open write transaction is not queued. |

**The tests fail without the queue.** With the queue bypassed, the
"write outside a transaction" test fails with `SQLITE_BUSY: database is
locked` — the exact hazard.

`npm run typecheck` passes. `npm test` passes: **90 files, 1338 tests**
(26 of them in `db/`).

---

## 6. What changed, file by file

| File | Change |
|---|---|
| `db/write-queue.ts` | **New.** The queue, the read/write classifier, the transaction context, the queued client. |
| `db/write-queue.test.ts` | **New.** The seven tests above. |
| `db/client.ts` | The queued client, `timeout` on the client config, `db.transaction` wrapped so every transaction body runs inside the transaction context, `closeDatabase` drains the queue first. |
| `db/README.md` | The queue, documented. |
| `db/PORT-REPORT.md` | §5.5 updated: the timeout is done, and it was never the whole fix. |

Nothing else was touched. The module-local queues (moderation, scrims)
are still there and are harmless: they are taken *before* the global
queue, and no transaction body calls a function that takes one.
